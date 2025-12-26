import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import * as puppeteer from 'puppeteer';
import { MessagesService } from '../messages/messages.service';

@Injectable()
export class PuppeteerService implements OnModuleDestroy {
  private readonly logger = new Logger(PuppeteerService.name);
  private browser: puppeteer.Browser | null = null;
  private page: puppeteer.Page | null = null;
  private isRunning = false;
  private messageCheckInterval: NodeJS.Timeout | null = null;
  private processedMessages: Set<string> = new Set();

  constructor(private readonly messagesService: MessagesService) {}

  async startMonitoring(phone?: string, password?: string, smsCode?: string): Promise<{ requiresSms: boolean; error?: string }> {
    if (this.isRunning) {
      this.logger.warn('Monitoring is already running');
      return;
    }

    try {
      this.logger.log('Starting Puppeteer browser...');
      this.browser = await puppeteer.launch({
        headless: false, // Показываем браузер для отладки, можно поставить true для продакшена
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-blink-features=AutomationControlled',
          '--disable-dev-shm-usage',
        ],
        defaultViewport: null,
      });

      this.page = await this.browser.newPage();
      this.page.setViewport({ width: 1920, height: 1080 });

      // Переходим на главную страницу Авито
      this.logger.log('Navigating to Avito main page...');
      try {
        await this.page.goto('https://www.avito.ru', {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        });
      } catch (error) {
        this.logger.warn('First navigation attempt failed, trying with load event...');
        await this.page.goto('https://www.avito.ru', {
          waitUntil: 'load',
          timeout: 30000,
        });
      }
      await this.page.waitForTimeout(3000);

      // Если переданы телефон и пароль, выполняем автоматическую авторизацию
      let isAlreadyLoggedIn = false;
      if (phone && password) {
        this.logger.log('═══════════════════════════════════════════════════════');
        this.logger.log('🔐 Выполняется автоматическая авторизация...');
        this.logger.log('═══════════════════════════════════════════════════════');
        
        try {
          const loginResult = await this.login(phone, password, smsCode);
          
          if (loginResult.error) {
            this.logger.error(`Ошибка авторизации: ${loginResult.error}`);
            return loginResult;
          }
          
          if (loginResult.requiresSms) {
            this.logger.log('⚠️ Требуется SMS-код');
            return loginResult;
          }
          
          this.logger.log('✅ Авторизация выполнена успешно!');
          // Проверяем, что авторизация действительно прошла
          isAlreadyLoggedIn = await this.checkIfLoggedIn();
          if (isAlreadyLoggedIn) {
            this.logger.log('✅ Авторизация подтверждена, переходим к мессенджеру');
          } else {
            return { requiresSms: false, error: 'Авторизация не подтверждена' };
          }
        } catch (error) {
          this.logger.error('Ошибка при автоматической авторизации:', error);
          return { requiresSms: false, error: error.message || 'Ошибка при авторизации' };
        }
      } else {
        // Если данные не переданы, ожидаем ручную авторизацию
        this.logger.log('═══════════════════════════════════════════════════════');
        this.logger.log('⏳ Ожидание ручной авторизации...');
        this.logger.log('📝 Пожалуйста, авторизуйтесь в Авито в открывшемся браузере');
        this.logger.log('═══════════════════════════════════════════════════════');
        isAlreadyLoggedIn = await this.checkIfLoggedIn();
      }

      // Автоматически открываем форму логина (если еще не авторизованы)
      if (!isAlreadyLoggedIn) {
        this.logger.log('Opening login form...');
        try {
          // Пробуем открыть форму логина через hash
          await this.page.goto('https://www.avito.ru/#login?authsrc=h', {
            waitUntil: 'domcontentloaded',
            timeout: 30000,
          });
          await this.page.waitForTimeout(2000);
          
          // Если форма не открылась, пробуем кликнуть на кнопку "Войти"
          const currentUrl = this.page.url();
          if (!currentUrl.includes('#login')) {
            this.logger.log('Login form not opened via hash, trying to click login button...');
            
            const loginButtonSelectors = [
              'a[href*="login"]',
              'a[href*="#login"]',
              '[data-marker*="login"]',
              'button:has-text("Войти")',
            ];
            
            let loginButtonClicked = false;
            for (const selector of loginButtonSelectors) {
              try {
                const buttons = await this.page.$$(selector);
                for (const button of buttons) {
                  const text = await this.page.evaluate((el) => el.textContent?.toLowerCase() || '', button);
                  const href = await this.page.evaluate((el) => (el as HTMLElement).getAttribute('href') || '', button);
                  
                  if (text.includes('войти') || text.includes('вход') || text.includes('login') || href?.includes('login')) {
                    this.logger.log(`Found login button, clicking...`);
                    await button.click();
                    await this.page.waitForTimeout(2000);
                    loginButtonClicked = true;
                    break;
                  }
                }
                if (loginButtonClicked) break;
              } catch (e) {
                continue;
              }
            }
          }
        } catch (error) {
          this.logger.warn('Error opening login form:', error);
        }

        // Если автоматическая авторизация не была выполнена, ждем ручную
        if (!phone || !password) {
          // Ждем до 5 минут, проверяя каждые 5 секунд, авторизовался ли пользователь
          let isLoggedIn = false;
          const maxWaitTime = 300; // 5 минут в секундах
          const checkInterval = 5; // проверяем каждые 5 секунд
          let waitedTime = 0;
          
          while (!isLoggedIn && waitedTime < maxWaitTime) {
            await this.page.waitForTimeout(checkInterval * 1000);
            waitedTime += checkInterval;
            
            try {
              isLoggedIn = await this.checkIfLoggedIn();
              if (isLoggedIn) {
                this.logger.log('✅ Пользователь авторизован! Продолжаем...');
                break;
              }
              
              if (waitedTime % 30 === 0) { // Каждые 30 секунд выводим сообщение
                this.logger.log(`⏳ Ожидание авторизации... (${waitedTime}/${maxWaitTime} секунд)`);
              }
            } catch (error) {
              this.logger.debug('Error checking login status:', error);
            }
          }
          
          if (!isLoggedIn) {
            throw new Error('Авторизация не выполнена в течение 5 минут. Пожалуйста, авторизуйтесь и попробуйте снова.');
          }
        } else {
          // Проверяем, что автоматическая авторизация прошла успешно
          await this.page.waitForTimeout(3000);
          const isLoggedIn = await this.checkIfLoggedIn();
          if (!isLoggedIn) {
            this.logger.warn('Автоматическая авторизация не подтверждена, ожидание ручной авторизации...');
            // Ждем еще немного для ручной авторизации, если автоматическая не сработала
            let waitedTime = 0;
            const maxWaitTime = 120; // 2 минуты
            while (waitedTime < maxWaitTime) {
              await this.page.waitForTimeout(5000);
              waitedTime += 5;
              const loggedIn = await this.checkIfLoggedIn();
              if (loggedIn) {
                this.logger.log('✅ Авторизация подтверждена!');
                break;
              }
            }
          }
        }
      }

      // Переходим в мессенджер если не находимся там
      await this.navigateToMessenger();

      this.isRunning = true;
      this.logger.log('═══════════════════════════════════════════════════════');
      this.logger.log('✅ МОНИТОРИНГ ЗАПУЩЕН И АКТИВЕН!');
      this.logger.log('═══════════════════════════════════════════════════════');
      this.logger.log('Starting message monitoring...');
      
      // Начинаем мониторинг сообщений
      this.startMessageMonitoring();
      this.logger.log('✅ Message monitoring interval started (checking every 3 seconds)');

      // Также настраиваем слушатель новых сообщений через DOM изменения
      await this.setupMessageListener();
      this.logger.log('✅ Message listener setup completed');
      
      // Делаем первую проверку сообщений сразу
      this.logger.log('Performing initial message check...');
      try {
        await this.checkForNewMessages();
        this.logger.log('✅ Initial message check completed');
      } catch (error) {
        this.logger.warn('Error in initial message check:', error);
      }
      
      this.logger.log('═══════════════════════════════════════════════════════');
      this.logger.log('📊 Мониторинг работает! Проверка сообщений каждые 3 секунды.');
      this.logger.log('📨 Новые сообщения от "Рушан" или "Рушан Натфуллин" будут появляться здесь.');
      this.logger.log('═══════════════════════════════════════════════════════');
      
      // Отправляем системное сообщение о готовности мониторинга
      this.messagesService.addMessage({
        id: `system_ready_${Date.now()}`,
        text: '✅ Мониторинг запущен и готов к работе! Ожидание сообщений от "Рушан" или "Рушан Натфуллин"...',
        sender: 'Система',
        timestamp: new Date().toISOString(),
      });
      
      return { requiresSms: false };
    } catch (error) {
      this.logger.error('Error starting monitoring:', error);
      await this.cleanup();
      return { requiresSms: false, error: error.message || 'Ошибка при запуске мониторинга' };
    }
  }

  private async checkIfLoggedIn(): Promise<boolean> {
    if (!this.page) return false;

    try {
      // Проверяем URL - если мы не на странице логина, возможно авторизованы
      const currentUrl = this.page.url();
      if (currentUrl.includes('/profile') || currentUrl.includes('/cabinet') || currentUrl.includes('/messenger')) {
        this.logger.log('Already logged in (detected by URL)');
        return true;
      }
      
      // Проверяем наличие элементов, которые появляются только после авторизации
      const profileButton = await this.page.$('a[href*="/profile"], a[href*="/cabinet"]');
      const messengerButton = await this.page.$('a[href*="/messenger"]');
      const userMenu = await this.page.$('[class*="user"], [class*="User"], [class*="profile"], [class*="Profile"]');
      
      // Проверяем отсутствие кнопки логина
      const authButton = await this.page.$('a[href*="/login"], a[href*="#login"]');
      
      // Также проверяем через JavaScript наличие элементов профиля
      const hasProfileElements = await this.page.evaluate(() => {
        const profileLinks = document.querySelectorAll('a[href*="/profile"], a[href*="/cabinet"]');
        const userElements = document.querySelectorAll('[class*="user"], [class*="User"]');
        const loginLinks = document.querySelectorAll('a[href*="/login"], a[href*="#login"]');
        
        return {
          hasProfile: profileLinks.length > 0,
          hasUser: userElements.length > 0,
          hasLogin: loginLinks.length > 0,
        };
      });
      
      // Если есть элементы профиля и нет кнопки логина, значит авторизованы
      const isLoggedIn = (profileButton !== null || messengerButton !== null || userMenu !== null || hasProfileElements.hasProfile) && 
                         (authButton === null && !hasProfileElements.hasLogin);
      
      if (isLoggedIn) {
        this.logger.log('User is logged in (detected by page elements)');
      }
      
      return isLoggedIn;
    } catch (error) {
      this.logger.error('Error checking login status:', error);
      return false;
    }
  }

  private async login(phone: string, password: string, smsCode?: string): Promise<{ requiresSms: boolean; error?: string }> {
    if (!this.page) throw new Error('Page is not initialized');

    try {
      // Авито использует hash routing для формы логина (#login)
      // Переходим на главную страницу с hash для открытия формы логина
      this.logger.log('Navigating to login page...');
      try {
        await this.page.goto('https://www.avito.ru/#login?authsrc=h', {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        });
      } catch (error) {
        this.logger.warn('Navigation failed, retrying...');
        await this.page.goto('https://www.avito.ru/#login?authsrc=h', {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        });
      }
      
      // Минимальное ожидание для загрузки формы
      await this.page.waitForTimeout(1000);
      
      // Проверяем, не авторизованы ли мы уже
      const currentUrl = this.page.url();
      if (currentUrl.includes('/profile') || currentUrl.includes('/cabinet') || currentUrl.includes('/messenger')) {
        this.logger.log('Already logged in');
        return;
      }

      // Ждем появления формы логина - используем точные селекторы из логов
      this.logger.log('Waiting for login form...');
      try {
        // Используем точные селекторы, которые мы знаем из логов
        await this.page.waitForSelector('input[data-marker="login-form/login/input"]', { 
          timeout: 10000, 
          visible: true 
        });
        this.logger.log('Login form detected');
      } catch (e) {
        // Если не нашли по data-marker, пробуем альтернативные селекторы
        try {
          await this.page.waitForSelector('input[name="login"], input[placeholder*="Телефон"], input[placeholder*="телефон"]', { 
            timeout: 5000, 
            visible: true 
          });
        } catch (e2) {
          this.logger.warn('Login form not found, but continuing...');
        }
      }
      
      // Минимальное ожидание для полной загрузки формы
      await this.page.waitForTimeout(500);

      // Используем точные селекторы для быстрого поиска полей
      // Приоритет: data-marker > name > placeholder
      const phoneSelectors = [
        'input[data-marker="login-form/login/input"]',
        'input[name="login"]',
        'input[placeholder*="Телефон"]',
        'input[placeholder*="телефон"]',
        'input[type="tel"]',
        'input[autocomplete="username"]',
      ];

      let phoneInput = null;
      
      // Быстро находим поле телефона
      for (const selector of phoneSelectors) {
        try {
          phoneInput = await this.page.$(selector);
          if (phoneInput) {
            const isVisible = await this.page.evaluate((el) => {
              const htmlEl = el as HTMLElement;
              const style = window.getComputedStyle(htmlEl);
              return htmlEl.offsetWidth > 0 && 
                     htmlEl.offsetHeight > 0 && 
                     style.display !== 'none' && 
                     style.visibility !== 'hidden';
            }, phoneInput);
            
            if (isVisible) {
              this.logger.log(`Found phone input: ${selector}`);
              break;
            }
            phoneInput = null;
          }
        } catch (e) {
          continue;
        }
      }

      if (!phoneInput) {
        throw new Error('Phone input field not found on login page');
      }

      // Вводим телефон - быстрая версия
      const normalizedPhone = phone.replace(/[\s\-\(\)]/g, '');
      this.logger.log(`Entering phone: ${normalizedPhone}`);
      
      await phoneInput.click({ clickCount: 3 });
      await phoneInput.type(normalizedPhone, { delay: 50 });
      await this.page.waitForTimeout(500);

      // Нажимаем кнопку "Далее" или Enter
      try {
        const nextButton = await this.page.$('button[type="submit"]');
        if (nextButton) {
          await nextButton.click();
        } else {
          await phoneInput.press('Enter');
        }
      } catch (e) {
        await phoneInput.press('Enter');
      }
      
      // Ждем появления поля пароля
      await this.page.waitForTimeout(1000);
      
      // Находим поле пароля - используем точные селекторы
      const passwordSelectors = [
        'input[data-marker="login-form/password/input"]',
        'input[name="password"]',
        'input[type="password"]',
        'input[autocomplete="current-password"]',
      ];
      
      let passwordInput: puppeteer.ElementHandle<Element> | null = null;
      for (const selector of passwordSelectors) {
        try {
          passwordInput = await this.page.$(selector);
          if (passwordInput) {
            const isVisible = await this.page.evaluate((el) => {
              const htmlEl = el as HTMLElement;
              return htmlEl.offsetWidth > 0 && htmlEl.offsetHeight > 0;
            }, passwordInput);
            if (isVisible) {
              this.logger.log(`Found password input: ${selector}`);
              break;
            }
            passwordInput = null;
          }
        } catch (e) {
          continue;
        }
      }
      
      if (!passwordInput) {
        // Проверяем, может уже авторизовались
        const url = this.page.url();
        if (url.includes('/profile') || url.includes('/cabinet') || url.includes('/messenger')) {
          this.logger.log('Already logged in after phone entry');
          return { requiresSms: false };
        }
        
        // Проверяем, не появилось ли поле для SMS-кода
        const smsCodeInput = await this.page.$('input[type="text"], input[type="number"], input[placeholder*="код"], input[placeholder*="Код"]');
        if (smsCodeInput) {
          const placeholder = await this.page.evaluate((el) => (el as HTMLInputElement).placeholder || '', smsCodeInput);
          const dataMarker = await this.page.evaluate((el) => (el as HTMLElement).getAttribute('data-marker') || '', smsCodeInput);
          
          if (placeholder.includes('код') || placeholder.includes('code') || dataMarker.includes('code') || dataMarker.includes('sms')) {
            this.logger.log('SMS code required');
            return { requiresSms: true };
          }
        }
        
        // Проверяем наличие ошибок на странице
        const errorText = await this.page.evaluate(() => {
          const errorElements = document.querySelectorAll('[class*="error"], [class*="Error"], [class*="invalid"], [class*="Invalid"]');
          for (const el of Array.from(errorElements)) {
            const text = el.textContent || '';
            if (text && (text.includes('неверн') || text.includes('неправильн') || text.includes('ошибк') || text.includes('error'))) {
              return text.trim();
            }
          }
          return null;
        });
        
        if (errorText) {
          return { requiresSms: false, error: errorText };
        }
        
        throw new Error('Password input field not found');
      }

      // Вводим пароль - быстрая версия
      this.logger.log('Entering password...');
      await passwordInput.click({ clickCount: 3 });
      await passwordInput.type(password, { delay: 50 });
      await this.page.waitForTimeout(500);
      
      // Делаем пароль видимым, изменяя тип поля на text
      await this.page.evaluate((el) => {
        (el as HTMLInputElement).type = 'text';
      }, passwordInput);
      this.logger.log('Password field changed to visible (text type)');

      // Нажимаем кнопку входа
      try {
        const submitButton = await this.page.$('button[type="submit"]');
        if (submitButton) {
          await submitButton.click();
        } else {
          await passwordInput.press('Enter');
        }
      } catch (e) {
        await passwordInput.press('Enter');
      }

      // Ждём ответа от сервера
      this.logger.log('Waiting for login response...');
      await this.page.waitForTimeout(3000);
      
      // ВАЖНО: Сначала проверяем, не появилось ли поле для SMS-кода
      // Используем более широкий поиск для надежности
      let smsCodeInput = await this.page.$('input[type="text"], input[type="number"], input[placeholder*="код"], input[placeholder*="Код"], input[data-marker*="code"], input[data-marker*="sms"]');
      
      // Если не нашли сразу, ждем еще немного и проверяем снова
      if (!smsCodeInput) {
        await this.page.waitForTimeout(1000);
        smsCodeInput = await this.page.$('input[type="text"], input[type="number"], input[placeholder*="код"], input[placeholder*="Код"], input[data-marker*="code"], input[data-marker*="sms"]');
      }
      
      if (smsCodeInput) {
        const placeholder = await this.page.evaluate((el) => (el as HTMLInputElement).placeholder || '', smsCodeInput);
        const dataMarker = await this.page.evaluate((el) => (el as HTMLElement).getAttribute('data-marker') || '', smsCodeInput);
        const inputType = await this.page.evaluate((el) => (el as HTMLInputElement).type || '', smsCodeInput);
        
        // Проверяем, что это действительно поле для SMS-кода
        const isSmsField = placeholder.includes('код') || 
                          placeholder.includes('code') || 
                          placeholder.includes('Код') ||
                          dataMarker.includes('code') || 
                          dataMarker.includes('sms') ||
                          dataMarker.includes('Code') ||
                          dataMarker.includes('SMS');
        
        if (isSmsField) {
          this.logger.log('SMS code required after password');
          
          // Если SMS-код передан, вводим его
          if (smsCode) {
            this.logger.log('Entering SMS code...');
            await smsCodeInput.click({ clickCount: 3 });
            await smsCodeInput.type(smsCode, { delay: 50 });
            await this.page.waitForTimeout(500);
            
            // Нажимаем кнопку подтверждения
            try {
              const confirmButton = await this.page.$('button[type="submit"]');
              if (confirmButton) {
                await confirmButton.click();
              } else {
                await smsCodeInput.press('Enter');
              }
            } catch (e) {
              await smsCodeInput.press('Enter');
            }
            
            await this.page.waitForTimeout(2000);
            
            // Проверяем, не появилась ли ошибка
            const errorText = await this.page.evaluate(() => {
              const errorElements = document.querySelectorAll('[class*="error"], [class*="Error"], [class*="invalid"], [class*="Invalid"]');
              for (const el of Array.from(errorElements)) {
                const text = el.textContent || '';
                if (text && (text.includes('неверн') || text.includes('неправильн') || text.includes('ошибк') || text.includes('error'))) {
                  return text.trim();
                }
              }
              return null;
            });
            
            if (errorText) {
              return { requiresSms: true, error: errorText };
            }
            
            // Проверяем авторизацию после ввода SMS-кода
            const isLoggedInAfterSms = await this.checkIfLoggedIn();
            if (!isLoggedInAfterSms) {
              // Если все еще требуется SMS-код, значит код был неверный
              await this.page.waitForTimeout(1000);
              const smsCodeInputStillPresent = await this.page.$('input[type="text"], input[type="number"], input[placeholder*="код"], input[placeholder*="Код"], input[data-marker*="code"], input[data-marker*="sms"]');
              if (smsCodeInputStillPresent) {
                const placeholderStill = await this.page.evaluate((el) => (el as HTMLInputElement).placeholder || '', smsCodeInputStillPresent);
                const dataMarkerStill = await this.page.evaluate((el) => (el as HTMLElement).getAttribute('data-marker') || '', smsCodeInputStillPresent);
                if (placeholderStill.includes('код') || placeholderStill.includes('code') || dataMarkerStill.includes('code') || dataMarkerStill.includes('sms')) {
                  return { requiresSms: true, error: 'Неверный SMS-код. Введите код заново.' };
                }
              }
            } else {
              this.logger.log('Login verified successfully after SMS code');
            }
          } else {
            // SMS-код не передан, возвращаем требование
            return { requiresSms: true };
          }
        }
      }
      
      // Проверяем наличие ошибок на странице
      const errorText = await this.page.evaluate(() => {
        const errorElements = document.querySelectorAll('[class*="error"], [class*="Error"], [class*="invalid"], [class*="Invalid"]');
        for (const el of Array.from(errorElements)) {
          const text = el.textContent || '';
          if (text && (text.includes('неверн') || text.includes('неправильн') || text.includes('ошибк') || text.includes('error'))) {
            return text.trim();
          }
        }
        return null;
      });
      
      if (errorText) {
        return { requiresSms: false, error: errorText };
      }
      
      // Проверяем авторизацию
      const isLoggedIn = await this.checkIfLoggedIn();
      if (!isLoggedIn) {
        // Даем еще немного времени
        await this.page.waitForTimeout(2000);
        
        // ПЕРЕД проверкой ошибок, проверяем, не появилось ли поле для SMS-кода
        const smsCodeInputCheck = await this.page.$('input[type="text"], input[type="number"], input[placeholder*="код"], input[placeholder*="Код"]');
        if (smsCodeInputCheck) {
          const placeholder = await this.page.evaluate((el) => (el as HTMLInputElement).placeholder || '', smsCodeInputCheck);
          const dataMarker = await this.page.evaluate((el) => (el as HTMLElement).getAttribute('data-marker') || '', smsCodeInputCheck);
          
          if (placeholder.includes('код') || placeholder.includes('code') || dataMarker.includes('code') || dataMarker.includes('sms')) {
            this.logger.log('SMS code required (detected after password check)');
            if (!smsCode) {
              return { requiresSms: true };
            }
            // Если SMS-код уже был введен, но все еще требуется, значит он неверный
            return { requiresSms: true, error: 'Неверный SMS-код. Введите код заново.' };
          }
        }
        
        const isLoggedInRetry = await this.checkIfLoggedIn();
        if (!isLoggedInRetry) {
          // Проверяем еще раз ошибки
          const finalErrorText = await this.page.evaluate(() => {
            const errorElements = document.querySelectorAll('[class*="error"], [class*="Error"], [class*="invalid"], [class*="Invalid"]');
            for (const el of Array.from(errorElements)) {
              const text = el.textContent || '';
              if (text && (text.includes('неверн') || text.includes('неправильн') || text.includes('ошибк') || text.includes('error'))) {
                return text.trim();
              }
            }
            return null;
          });
          
          if (finalErrorText) {
            return { requiresSms: false, error: finalErrorText };
          }
          
          return { requiresSms: false, error: 'Авторизация не удалась. Проверьте правильность данных.' };
        } else {
          this.logger.log('Login verified successfully');
        }
      } else {
        this.logger.log('Login verified successfully');
      }
      
      return { requiresSms: false };

      this.logger.log('Login process completed');
      return { requiresSms: false };
    } catch (error) {
      this.logger.error('Error during login:', error);
      
      // Делаем скриншот при ошибке
      if (this.page) {
        try {
          await this.page.screenshot({ path: 'error-login-page.png' });
          this.logger.log('Error screenshot saved to error-login-page.png');
        } catch (e) {
          // Игнорируем ошибку скриншота
        }
      }
      
      return { requiresSms: false, error: error.message || 'Ошибка при авторизации' };
    }
  }

  private async navigateToMessenger(): Promise<void> {
    if (!this.page) {
      this.logger.error('Page is not initialized, cannot navigate to messenger');
      return;
    }

    try {
      const currentUrl = this.page.url();
      this.logger.log(`Current URL before navigating to messenger: ${currentUrl}`);
      
      // Пробуем найти и кликнуть на ссылку мессенджера вместо прямого перехода
      this.logger.log('Looking for messenger link...');
      let messengerOpened = false;
      
      // Пробуем найти ссылку на мессенджер
      const messengerLinkSelectors = [
        'a[href*="messenger"]',
        'a[href*="/profile/messenger"]',
        '[data-marker*="messenger"]',
        '[class*="messenger"]',
      ];
      
      for (const selector of messengerLinkSelectors) {
        try {
          const links = await this.page.$$(selector);
          for (const link of links) {
            const text = await this.page.evaluate((el) => el.textContent?.toLowerCase() || '', link);
            const href = await this.page.evaluate((el) => (el as HTMLElement).getAttribute('href') || '', link);
            
            if (text.includes('сообщени') || text.includes('мессенджер') || href?.includes('messenger')) {
              this.logger.log(`Found messenger link, clicking... (href: ${href})`);
              await link.click();
              await this.page.waitForTimeout(3000);
              messengerOpened = true;
              break;
            }
          }
          if (messengerOpened) break;
        } catch (e) {
          continue;
        }
      }
      
      // Если не нашли ссылку, пробуем прямую навигацию на разные варианты URL
      if (!messengerOpened) {
        this.logger.log('Messenger link not found, trying direct navigation...');
        const messengerUrls = [
          'https://www.avito.ru/profile/messenger',
          'https://www.avito.ru/cabinet/messenger',
          'https://www.avito.ru/messenger',
        ];
        
        for (const url of messengerUrls) {
          try {
            this.logger.log(`Trying to navigate to: ${url}`);
            await this.page.goto(url, {
              waitUntil: 'domcontentloaded',
              timeout: 15000,
            });
            await this.page.waitForTimeout(2000);
            
            const finalUrl = this.page.url();
            this.logger.log(`Current URL: ${finalUrl}`);
            
            // Проверяем, что мы действительно на странице мессенджера
            if (finalUrl.includes('messenger') || finalUrl.includes('message')) {
              messengerOpened = true;
              this.logger.log(`✅ Successfully navigated to messenger: ${finalUrl}`);
              break;
            }
          } catch (error) {
            this.logger.warn(`Failed to navigate to ${url}:`, error);
            continue;
          }
        }
      }
      
      if (!messengerOpened) {
        this.logger.warn('⚠️ Could not automatically navigate to messenger');
        this.logger.warn('⚠️ Please manually navigate to messenger in the browser');
        this.logger.warn('⚠️ Мониторинг будет работать, когда вы откроете мессенджер вручную');
      } else {
        const messengerUrl = this.page.url();
        this.logger.log(`✅ Успешно открыли мессенджер: ${messengerUrl}`);
      }
      
      // Дополнительная проверка - убеждаемся, что страница мессенджера загружена
      await this.page.waitForTimeout(2000);
      const currentMessengerUrl = this.page.url();
      this.logger.log(`📍 Текущий URL: ${currentMessengerUrl}`);
      
      // Отправляем системное сообщение о готовности мессенджера
      if (messengerOpened || currentMessengerUrl.includes('messenger') || currentMessengerUrl.includes('message')) {
        this.messagesService.addMessage({
          id: `system_messenger_ready_${Date.now()}`,
          text: `✅ Мессенджер открыт! Мониторинг активен и готов к работе.`,
          sender: 'Система',
          timestamp: new Date().toISOString(),
        });
      }
    } catch (error) {
      this.logger.error('Error navigating to messenger:', error);
      throw error;
    }
  }

  private startMessageMonitoring(): void {
    // Проверяем новые сообщения каждые 3 секунды
    let checkCount = 0;
    this.messageCheckInterval = setInterval(async () => {
      if (!this.isRunning || !this.page) {
        this.logger.warn('Monitoring stopped or page not available');
        return;
      }

      checkCount++;
      // Каждые 10 проверок (30 секунд) выводим статус
      if (checkCount % 10 === 0) {
        this.logger.log(`🔄 Мониторинг активен: выполнено ${checkCount} проверок сообщений...`);
      }

      try {
        await this.checkForNewMessages();
      } catch (error) {
        this.logger.error('Error checking messages:', error);
      }
    }, 3000);
    
    this.logger.log(`✅ Интервал мониторинга установлен: проверка каждые 3 секунды`);
  }

  private async setupMessageListener(): Promise<void> {
    if (!this.page) return;

    try {
      // Внедряем JavaScript для отслеживания новых сообщений
      await this.page.evaluate(() => {
        // Функция для поиска сообщений от нужного пользователя
        const observer = new MutationObserver(() => {
          // Триггер проверки сообщений
          window.dispatchEvent(new CustomEvent('checkMessages'));
        });

        // Наблюдаем за изменениями в DOM
        const targetNode = document.body;
        observer.observe(targetNode, {
          childList: true,
          subtree: true,
        });
      });

      // Слушаем событие проверки сообщений
      this.page.on('console', (msg) => {
        if (msg.text().includes('NEW_MESSAGE')) {
          this.checkForNewMessages();
        }
      });
    } catch (error) {
      this.logger.error('Error setting up message listener:', error);
    }
  }

  private async checkForNewMessages(): Promise<void> {
    if (!this.page) {
      this.logger.warn('Page is not available for message check');
      return;
    }

    try {
      // Проверяем, что мы на странице мессенджера
      const currentUrl = this.page.url();
      const isOnMessengerPage = currentUrl.includes('messenger') || 
                                 currentUrl.includes('message') || 
                                 currentUrl.includes('/profile/') ||
                                 currentUrl.includes('/cabinet/');
      
      if (!isOnMessengerPage) {
        this.logger.debug(`⚠️ Not on messenger page (current URL: ${currentUrl}), skipping message check`);
        return;
      }
      
      this.logger.debug('🔍 Checking for new messages from "Рушан" or "Рушан Натфуллин"...');
      // Ищем все чаты и сообщения от нужного пользователя
      const messages = await this.page.evaluate((targetNames) => {
        const foundMessages: Array<{
          id: string;
          text: string;
          sender: string;
          phoneNumber?: string;
          timestamp: string;
        }> = [];
        
        // Функция для извлечения номера телефона из текста
        const extractPhoneNumber = (text: string): string | undefined => {
          // Ищем паттерны телефонов: +7XXXXXXXXXX, 8XXXXXXXXXX, и т.д.
          const phonePatterns = [
            /\+7\d{10}/g,
            /8\d{10}/g,
            /\+7\s?\(\d{3}\)\s?\d{3}[\s-]?\d{2}[\s-]?\d{2}/g,
            /8\s?\(\d{3}\)\s?\d{3}[\s-]?\d{2}[\s-]?\d{2}/g,
          ];
          
          for (const pattern of phonePatterns) {
            const match = text.match(pattern);
            if (match && match.length > 0) {
              return match[0].replace(/\s/g, '');
            }
          }
          return undefined;
        };

        // Ищем элементы чатов/диалогов
        const chatItems = document.querySelectorAll('[class*="chat"], [class*="dialog"], [class*="conversation"]');
        
        for (const chat of chatItems) {
          const chatText = chat.textContent || '';
          const chatHtml = chat.innerHTML || '';

          // Проверяем, содержит ли чат имя целевого пользователя
          const matchesTarget = targetNames.some(name => 
            chatText.includes(name) || chatHtml.includes(name)
          );

          if (matchesTarget) {
            // Ищем номер телефона в чате
            const phoneNumber = extractPhoneNumber(chatText) || extractPhoneNumber(chatHtml);
            
            // Ищем сообщения внутри чата
            const messageElements = chat.querySelectorAll('[class*="message"], [class*="text"]');
            
            messageElements.forEach((msg, index) => {
              const messageText = msg.textContent?.trim() || '';
              if (messageText) {
                foundMessages.push({
                  id: `${chatText}_${index}_${Date.now()}`,
                  text: messageText,
                  sender: targetNames.find(name => chatText.includes(name)) || 'Unknown',
                  phoneNumber: phoneNumber,
                  timestamp: new Date().toISOString(),
                });
              }
            });
          }
        }

        // Альтернативный подход: поиск по всему DOM
        const allText = document.body.textContent || '';
        if (targetNames.some(name => allText.includes(name))) {
          // Ищем последние сообщения
          const messageContainers = document.querySelectorAll('[class*="message"]');
          messageContainers.forEach((container, index) => {
            const text = container.textContent?.trim() || '';
            if (text && text.length > 0) {
              const phoneNumber = extractPhoneNumber(text);
              foundMessages.push({
                id: `msg_${index}_${Date.now()}`,
                text: text,
                sender: targetNames.find(name => text.includes(name)) || 'Рушан',
                phoneNumber: phoneNumber,
                timestamp: new Date().toISOString(),
              });
            }
          });
        }

        return foundMessages;
      }, ['Рушан Натфуллин', 'Рушан']);

      // Обрабатываем найденные сообщения
      this.logger.debug(`Found ${messages.length} potential messages`);
      
      let newMessagesCount = 0;
      for (const message of messages) {
        // Используем текст сообщения для проверки уникальности
        const messageKey = `${message.sender}_${message.text.substring(0, 100)}`;
        if (!this.processedMessages.has(messageKey) && message.text.trim()) {
          this.processedMessages.add(messageKey);
          newMessagesCount++;
          this.logger.log(`New message from ${message.sender}: ${message.text.substring(0, 50)}...`);
          
          // Отправляем сообщение через сервис
          this.messagesService.addMessage({
            id: message.id,
            text: message.text,
            sender: message.sender,
            phoneNumber: message.phoneNumber,
            timestamp: message.timestamp,
          });
        }
      }
      
      if (newMessagesCount > 0) {
        this.logger.log(`✅ Найдено и обработано ${newMessagesCount} новое(ых) сообщение(й)!`);
      } else {
        this.logger.debug('ℹ️ Новых сообщений не найдено (проверка выполнена)');
      }

      // Также пытаемся получить сообщения через более специфичный селектор
      await this.extractMessagesFromPage();
    } catch (error) {
      this.logger.error('Error checking for new messages:', error);
    }
  }

  private async extractMessagesFromPage(): Promise<void> {
    if (!this.page) return;

    try {
      // Более специфичный подход: ищем чат с нужным пользователем
      const messages = await this.page.evaluate((targetNames) => {
        const foundMessages: Array<{
          id: string;
          text: string;
          sender: string;
          phoneNumber?: string;
          timestamp: string;
        }> = [];
        
        // Функция для извлечения номера телефона из текста
        const extractPhoneNumber = (text: string): string | undefined => {
          const phonePatterns = [
            /\+7\d{10}/g,
            /8\d{10}/g,
            /\+7\s?\(\d{3}\)\s?\d{3}[\s-]?\d{2}[\s-]?\d{2}/g,
            /8\s?\(\d{3}\)\s?\d{3}[\s-]?\d{2}[\s-]?\d{2}/g,
          ];
          
          for (const pattern of phonePatterns) {
            const match = text.match(pattern);
            if (match && match.length > 0) {
              return match[0].replace(/\s/g, '');
            }
          }
          return undefined;
        };

        // Пытаемся найти элементы чатов с нужным именем
        const possibleSelectors = [
          'a[href*="/messenger"]',
          '[class*="chat-item"]',
          '[class*="conversation-item"]',
          '[class*="dialog-item"]',
          '[data-test-id*="chat"]',
        ];

        for (const selector of possibleSelectors) {
          try {
            const elements = document.querySelectorAll(selector);
            for (const el of Array.from(elements)) {
              const text = el.textContent || '';
              if (targetNames.some(name => text.includes(name))) {
                // Нашли чат с нужным пользователем
                // Пытаемся получить последнее сообщение из превью чата
                const previewText = text.split('\n').pop()?.trim();
                if (previewText && previewText.length > 0 && previewText.length < 500) {
                  const phoneNumber = extractPhoneNumber(text) || extractPhoneNumber(previewText);
                  foundMessages.push({
                    id: `preview_${Date.now()}_${Math.random()}`,
                    text: previewText,
                    sender: targetNames.find(name => text.includes(name)) || 'Рушан',
                    phoneNumber: phoneNumber,
                    timestamp: new Date().toISOString(),
                  });
                }
              }
            }
          } catch (e) {
            // Игнорируем ошибки селекторов
          }
        }

        // Также ищем открытый чат с сообщениями
        const messageContainers = document.querySelectorAll('[class*="message"], [class*="Message"]');
        for (const container of Array.from(messageContainers)) {
          const text = container.textContent?.trim() || '';
          if (text && text.length > 0 && text.length < 1000) {
            // Проверяем, что это не системное сообщение и не дубликат
            if (!text.includes('Написать') && !text.includes('сообщение')) {
              const phoneNumber = extractPhoneNumber(text);
              foundMessages.push({
                id: `msg_${Date.now()}_${Math.random()}`,
                text: text,
                sender: 'Рушан',
                phoneNumber: phoneNumber,
                timestamp: new Date().toISOString(),
              });
            }
          }
        }

        return foundMessages;
      }, ['Рушан Натфуллин', 'Рушан']);

      // Обрабатываем найденные сообщения
      for (const message of messages) {
        // Используем текст как уникальный идентификатор для проверки дубликатов
        const messageKey = `${message.sender}_${message.text.substring(0, 100)}`;
        if (!this.processedMessages.has(messageKey) && message.text.trim()) {
          this.processedMessages.add(messageKey);
          this.logger.log(`Extracted message from ${message.sender}: ${message.text.substring(0, 50)}...`);
          
          this.messagesService.addMessage({
            id: message.id,
            text: message.text,
            sender: message.sender,
            phoneNumber: message.phoneNumber,
            timestamp: message.timestamp,
          });
        }
      }
    } catch (error) {
      // Игнорируем ошибки при извлечении - это не критично
      this.logger.debug('Error extracting messages:', error);
    }
  }

  async stopMonitoring(): Promise<void> {
    this.logger.log('Stopping monitoring...');
    this.isRunning = false;

    if (this.messageCheckInterval) {
      clearInterval(this.messageCheckInterval);
      this.messageCheckInterval = null;
    }

    // Очищаем список обработанных сообщений
    this.processedMessages.clear();

    await this.cleanup();
  }

  private async cleanup(): Promise<void> {
    try {
      if (this.browser) {
        await this.browser.close();
        this.browser = null;
        this.page = null;
        this.logger.log('Browser closed');
      }
    } catch (error) {
      this.logger.error('Error during cleanup:', error);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.stopMonitoring();
  }

  getStatus(): { isRunning: boolean; browserOpen: boolean; currentUrl?: string; processedMessagesCount?: number } {
    return {
      isRunning: this.isRunning,
      browserOpen: this.browser !== null,
      currentUrl: this.page?.url(),
      processedMessagesCount: this.processedMessages.size,
    };
  }
}
