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

  async startMonitoring(): Promise<void> {
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

      // Автоматически открываем форму логина
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

      // Ждем ручной авторизации пользователя
      this.logger.log('═══════════════════════════════════════════════════════');
      this.logger.log('⏳ Ожидание ручной авторизации...');
      this.logger.log('📝 Пожалуйста, авторизуйтесь в Авито в открывшемся браузере');
      this.logger.log('═══════════════════════════════════════════════════════');
      
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
    } catch (error) {
      this.logger.error('Error starting monitoring:', error);
      await this.cleanup();
      throw error;
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

  private async login(phone: string, password: string): Promise<void> {
    if (!this.page) throw new Error('Page is not initialized');

    try {
      // Авито использует hash routing для формы логина (#login)
      // Переходим на главную страницу с hash для открытия формы логина
      this.logger.log('Navigating to login page with hash routing...');
      try {
        await this.page.goto('https://www.avito.ru/#login?authsrc=h', {
          waitUntil: 'networkidle2',
          timeout: 60000,
        });
      } catch (error) {
        this.logger.warn('Navigation with networkidle2 failed, trying with load...');
        try {
          await this.page.goto('https://www.avito.ru/#login?authsrc=h', {
            waitUntil: 'load',
            timeout: 60000,
          });
        } catch (e2) {
          this.logger.warn('Navigation with load failed, trying with domcontentloaded...');
          await this.page.goto('https://www.avito.ru/#login?authsrc=h', {
            waitUntil: 'domcontentloaded',
            timeout: 60000,
          });
        }
      }
      
      // Ждем полной загрузки страницы
      await this.page.waitForTimeout(3000);
      
      // Логируем текущий URL для отладки
      let currentUrl = this.page.url();
      this.logger.log(`Current URL after navigation: ${currentUrl}`);
      
      // Если форма логина не открылась через hash, пробуем кликнуть на кнопку "Войти"
      if (!currentUrl.includes('#login')) {
        this.logger.log('Login form not opened via hash, trying to click login button...');
        
        // Ищем кнопку "Войти" или "Вход и регистрация"
        const loginButtonSelectors = [
          'a[href*="login"]',
          'a[href*="#login"]',
          'button:has-text("Войти")',
          '[data-marker*="login"]',
          '[data-marker*="Login"]',
        ];
        
        let loginButtonClicked = false;
        for (const selector of loginButtonSelectors) {
          try {
            const buttons = await this.page.$$(selector);
            for (const button of buttons) {
              const text = await this.page.evaluate((el) => el.textContent?.toLowerCase() || '', button);
              const href = await this.page.evaluate((el) => (el as HTMLElement).getAttribute('href') || '', button);
              
              if (text.includes('войти') || text.includes('вход') || text.includes('login') || href?.includes('login')) {
                this.logger.log(`Found login button with selector: ${selector}, text: ${text}, href: ${href}`);
                await button.click();
                await this.page.waitForTimeout(3000);
                loginButtonClicked = true;
                
                currentUrl = this.page.url();
                this.logger.log(`Current URL after clicking login button: ${currentUrl}`);
                break;
              }
            }
            if (loginButtonClicked) break;
          } catch (e) {
            continue;
          }
        }
        
        // Если не нашли кнопку через селекторы, пробуем найти через текст
        if (!loginButtonClicked) {
          try {
            const allLinks = await this.page.$$('a');
            for (const link of allLinks) {
              const text = await this.page.evaluate((el) => el.textContent?.toLowerCase() || '', link);
              const href = await this.page.evaluate((el) => (el as HTMLElement).getAttribute('href') || '', link);
              
              if ((text.includes('войти') || text.includes('вход') || href?.includes('login')) && !text.includes('регистрация')) {
                this.logger.log(`Found login link by text: ${text}, href: ${href}`);
                await link.click();
                await this.page.waitForTimeout(3000);
                loginButtonClicked = true;
                
                currentUrl = this.page.url();
                this.logger.log(`Current URL after clicking login link: ${currentUrl}`);
                break;
              }
            }
          } catch (e) {
            this.logger.warn('Error searching for login link:', e);
          }
        }
      }
      
      // Дополнительное ожидание для загрузки формы логина через JavaScript
      await this.page.waitForTimeout(3000);
      
      // Пробуем дождаться появления формы логина (input поля)
      this.logger.log('Waiting for login form to appear...');
      try {
        // Ждем появления любого input поля (форма логина должна содержать input)
        await this.page.waitForSelector('input', { timeout: 15000 });
        this.logger.log('Input elements detected on page');
      } catch (e) {
        this.logger.warn('No input elements found, but continuing...');
      }
      
      // Дополнительное ожидание для динамической загрузки формы
      await this.page.waitForTimeout(2000);
      
      currentUrl = this.page.url();
      this.logger.log(`Final URL: ${currentUrl}`);

      // Проверяем, не авторизованы ли мы уже
      if (currentUrl.includes('/profile') || currentUrl.includes('/cabinet') || currentUrl.includes('/messenger')) {
        this.logger.log('Already logged in');
        return;
      }

      // Ждем появления формы логина - пробуем разные селекторы для модального окна или формы
      this.logger.log('Waiting for login form to fully load...');
      const formSelectors = [
        '[class*="modal"]',
        '[class*="Modal"]',
        '[class*="dialog"]',
        '[class*="Dialog"]',
        '[class*="popup"]',
        '[class*="Popup"]',
        '[class*="auth"]',
        '[class*="Auth"]',
        '[class*="login"]',
        '[class*="Login"]',
        'form',
      ];
      
      let formFound = false;
      for (const selector of formSelectors) {
        try {
          await this.page.waitForSelector(selector, { timeout: 5000 });
          this.logger.log(`Found form container with selector: ${selector}`);
          formFound = true;
          break;
        } catch (e) {
          continue;
        }
      }
      
      if (!formFound) {
        this.logger.warn('No form container found, but continuing...');
      }
      
      // Дополнительное ожидание для полной загрузки формы
      await this.page.waitForTimeout(3000);
      
      // Пробуем прокрутить страницу наверх, если форма в модальном окне
      try {
        await this.page.evaluate(() => {
          window.scrollTo(0, 0);
        });
        await this.page.waitForTimeout(1000);
      } catch (e) {
        // Игнорируем ошибки прокрутки
      }
      
      // Сначала получаем все input поля для анализа
      this.logger.log('Analyzing page inputs...');
      const allInputs = await this.page.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll('input'));
        return inputs.map(input => ({
          type: input.type,
          name: input.name,
          id: input.id,
          placeholder: input.placeholder,
          className: input.className,
          autocomplete: input.getAttribute('autocomplete'),
          'data-marker': input.getAttribute('data-marker'),
          'data-test-id': input.getAttribute('data-test-id'),
          visible: input.offsetWidth > 0 && input.offsetHeight > 0,
          parentTag: input.parentElement?.tagName,
          parentClass: input.parentElement?.className,
        }));
      });
      this.logger.log('Available inputs on page:', JSON.stringify(allInputs, null, 2));

      // Множественные варианты селекторов для поля телефона
      const phoneSelectors = [
        'input[type="tel"]',
        'input[name="phone"]',
        'input[id*="phone"]',
        'input[id*="Phone"]',
        'input[placeholder*="телефон"]',
        'input[placeholder*="Телефон"]',
        'input[placeholder*="PHONE"]',
        'input[placeholder*="Phone"]',
        'input[autocomplete="tel"]',
        'input[autocomplete*="tel"]',
        'input[data-marker*="phone"]',
        'input[data-marker*="Phone"]',
        'input[data-test-id*="phone"]',
        'input.input-input-3rFv2',
        'input[class*="input"]',
      ];

      let phoneInput = null;
      let foundSelector = '';

      // Пробуем найти поле телефона разными селекторами
      // Сначала пробуем дождаться появления поля с таймаутом
      for (const selector of phoneSelectors) {
        try {
          this.logger.log(`Trying selector: ${selector}`);
          // Пробуем дождаться появления элемента
          try {
            await this.page.waitForSelector(selector, { timeout: 3000, visible: true });
          } catch (e) {
            // Если не появилось за 3 секунды, пробуем просто найти
          }
          
          const element = await this.page.$(selector);
          if (element) {
            // Проверяем, что элемент видимый
            const isVisible = await this.page.evaluate((el) => {
              const htmlEl = el as HTMLElement;
              const style = window.getComputedStyle(htmlEl);
              return htmlEl.offsetWidth > 0 && 
                     htmlEl.offsetHeight > 0 && 
                     style.display !== 'none' && 
                     style.visibility !== 'hidden' &&
                     style.opacity !== '0';
            }, element);
            
            if (isVisible) {
              phoneInput = element;
              foundSelector = selector;
              this.logger.log(`Found phone input with selector: ${selector}`);
              break;
            } else {
              this.logger.log(`Element found but not visible: ${selector}`);
            }
          }
        } catch (e) {
          // Продолжаем искать
          continue;
        }
      }

      // Если не нашли стандартными селекторами, пробуем через XPath
      if (!phoneInput) {
        this.logger.log('Standard selectors failed, trying XPath...');
        
        try {
          const phoneInputs = await this.page.$x(
            "//input[contains(@placeholder, 'телефон') or contains(@placeholder, 'Телефон') or contains(@placeholder, 'phone') or contains(@placeholder, 'Phone') or contains(@name, 'phone') or contains(@id, 'phone')]"
          );
          if (phoneInputs.length > 0) {
            for (const input of phoneInputs) {
              const isVisible = await this.page.evaluate((el) => {
                const htmlEl = el as HTMLElement;
                const style = window.getComputedStyle(htmlEl);
                return htmlEl.offsetWidth > 0 && 
                       htmlEl.offsetHeight > 0 && 
                       style.display !== 'none' && 
                       style.visibility !== 'hidden' &&
                       style.opacity !== '0';
              }, input);
              if (isVisible) {
                phoneInput = input;
                this.logger.log('Found phone input via XPath');
                break;
              }
            }
          }
        } catch (e) {
          this.logger.warn('XPath search failed:', e);
        }
      }

      // Если все еще не нашли, пробуем найти через анализ всех input полей
      if (!phoneInput) {
        this.logger.log('Trying to find phone input by analyzing all inputs...');
        
        try {
          const inputs = await this.page.$$('input');
          for (const input of inputs) {
            const inputInfo = await this.page.evaluate((el) => {
              const htmlEl = el as HTMLInputElement;
              return {
                type: htmlEl.type,
                name: htmlEl.name,
                id: htmlEl.id,
                placeholder: htmlEl.placeholder,
                className: htmlEl.className,
                autocomplete: htmlEl.getAttribute('autocomplete'),
                visible: htmlEl.offsetWidth > 0 && htmlEl.offsetHeight > 0,
              };
            }, input);

            // Проверяем различные признаки поля телефона
            const isPhoneField = 
              inputInfo.type === 'tel' ||
              inputInfo.name?.toLowerCase().includes('phone') ||
              inputInfo.id?.toLowerCase().includes('phone') ||
              inputInfo.placeholder?.toLowerCase().includes('телефон') ||
              inputInfo.placeholder?.toLowerCase().includes('phone') ||
              inputInfo.autocomplete?.includes('tel');

            if (isPhoneField && inputInfo.visible) {
              phoneInput = input;
              this.logger.log(`Found phone input by analysis: ${JSON.stringify(inputInfo)}`);
              break;
            }
          }
        } catch (e) {
          this.logger.warn('Input analysis failed:', e);
        }
      }

      // Если все еще не нашли, пробуем первый видимый input (может быть это поле телефона)
      if (!phoneInput) {
        this.logger.log('Trying to use first visible input as phone field...');
        try {
          const inputs = await this.page.$$('input');
          for (const input of inputs) {
            const isVisible = await this.page.evaluate((el) => {
              const htmlEl = el as HTMLInputElement;
              const style = window.getComputedStyle(htmlEl);
              return htmlEl.offsetWidth > 0 && 
                     htmlEl.offsetHeight > 0 && 
                     htmlEl.type !== 'hidden' && 
                     htmlEl.type !== 'submit' && 
                     htmlEl.type !== 'button' &&
                     style.display !== 'none' && 
                     style.visibility !== 'hidden' &&
                     style.opacity !== '0';
            }, input);
            
            if (isVisible) {
              phoneInput = input;
              this.logger.log('Using first visible input as phone field');
              break;
            }
          }
        } catch (e) {
          this.logger.warn('Failed to find any visible input:', e);
        }
      }

      // Если все еще не нашли, пробуем поискать в iframe
      if (!phoneInput) {
        this.logger.log('Trying to find phone input in iframes...');
        try {
          const frames = this.page.frames();
          for (const frame of frames) {
            if (frame !== this.page.mainFrame()) {
              try {
                for (const selector of phoneSelectors.slice(0, 5)) { // Пробуем только основные селекторы
                  const element = await frame.$(selector);
                  if (element) {
                    const isVisible = await frame.evaluate((el) => {
                      const htmlEl = el as HTMLElement;
                      const style = window.getComputedStyle(htmlEl);
                      return htmlEl.offsetWidth > 0 && 
                             htmlEl.offsetHeight > 0 && 
                             style.display !== 'none' && 
                             style.visibility !== 'hidden';
                    }, element);
                    if (isVisible) {
                      phoneInput = element;
                      this.logger.log(`Found phone input in iframe with selector: ${selector}`);
                      break;
                    }
                  }
                }
                if (phoneInput) break;
              } catch (e) {
                continue;
              }
            }
          }
        } catch (e) {
          this.logger.warn('Error searching in iframes:', e);
        }
      }
      
      // Если все еще не нашли, пробуем найти через JavaScript напрямую
      if (!phoneInput) {
        this.logger.log('Trying to find phone input via direct JavaScript evaluation...');
        try {
          const foundInput = await this.page.evaluateHandle(() => {
            const inputs = Array.from(document.querySelectorAll('input'));
            for (const input of inputs) {
              const htmlInput = input as HTMLInputElement;
              const style = window.getComputedStyle(htmlInput);
              const isVisible = htmlInput.offsetWidth > 0 && 
                               htmlInput.offsetHeight > 0 && 
                               style.display !== 'none' && 
                               style.visibility !== 'hidden' &&
                               htmlInput.type !== 'hidden' &&
                               htmlInput.type !== 'submit' &&
                               htmlInput.type !== 'button';
              
              if (isVisible) {
                const type = htmlInput.type;
                const name = htmlInput.name?.toLowerCase() || '';
                const id = htmlInput.id?.toLowerCase() || '';
                const placeholder = htmlInput.placeholder?.toLowerCase() || '';
                const autocomplete = htmlInput.getAttribute('autocomplete')?.toLowerCase() || '';
                
                // Проверяем признаки поля телефона
                if (type === 'tel' ||
                    name.includes('phone') ||
                    id.includes('phone') ||
                    placeholder.includes('телефон') ||
                    placeholder.includes('phone') ||
                    autocomplete.includes('tel')) {
                  return input;
                }
              }
            }
            // Если не нашли по признакам, возвращаем первый видимый input
            for (const input of inputs) {
              const htmlInput = input as HTMLInputElement;
              const style = window.getComputedStyle(htmlInput);
              if (htmlInput.offsetWidth > 0 && 
                  htmlInput.offsetHeight > 0 && 
                  style.display !== 'none' && 
                  style.visibility !== 'hidden' &&
                  htmlInput.type !== 'hidden' &&
                  htmlInput.type !== 'submit' &&
                  htmlInput.type !== 'button') {
                return input;
              }
            }
            return null;
          });
          
          if (foundInput && foundInput.asElement()) {
            phoneInput = foundInput.asElement();
            this.logger.log('Found phone input via JavaScript evaluation');
          }
        } catch (e) {
          this.logger.warn('Error in JavaScript evaluation search:', e);
        }
      }
      
      // Если все еще не нашли, ждем и проверяем, авторизовался ли пользователь вручную
      if (!phoneInput) {
        this.logger.warn('Phone input field not found on login page');
        this.logger.log('Waiting for manual login or form to appear...');
        
        // Выводим дополнительную информацию о странице
        const pageInfo = await this.page.evaluate(() => {
          return {
            url: window.location.href,
            hash: window.location.hash,
            title: document.title,
            bodyText: document.body?.textContent?.substring(0, 500) || '',
            iframeCount: document.querySelectorAll('iframe').length,
            modalCount: document.querySelectorAll('[class*="modal"], [class*="Modal"]').length,
          };
        });
        this.logger.log('Page info:', JSON.stringify(pageInfo, null, 2));
        
        // Делаем скриншот для отладки
        try {
          await this.page.screenshot({ path: 'debug-login-page.png', fullPage: true });
          this.logger.log('Screenshot saved to debug-login-page.png');
        } catch (e) {
          this.logger.warn('Failed to save screenshot:', e);
        }

        // Ждем до 60 секунд, проверяя каждые 3 секунды, авторизовался ли пользователь
        this.logger.log('Waiting for manual login (up to 60 seconds)...');
        let loggedIn = false;
        for (let i = 0; i < 20; i++) {
          await this.page.waitForTimeout(3000);
          
          // Проверяем, авторизовались ли мы
          loggedIn = await this.checkIfLoggedIn();
          if (loggedIn) {
            this.logger.log('User logged in manually! Continuing...');
            return; // Выходим из метода login, авторизация успешна
          }
          
          // Также проверяем, не появилось ли поле телефона
          try {
            phoneInput = await this.page.$('input[type="tel"], input[name*="phone"], input[placeholder*="телефон"], input[placeholder*="Телефон"]');
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
                this.logger.log('Phone input appeared! Continuing with automatic login...');
                break; // Выходим из цикла ожидания, продолжаем автоматический логин
              }
            }
          } catch (e) {
            // Игнорируем ошибки
          }
          
          this.logger.log(`Waiting for login... (${(i + 1) * 3}/60 seconds)`);
        }
        
        // Если после ожидания все еще не авторизованы и нет поля телефона
        if (!loggedIn && !phoneInput) {
          // Проверяем еще раз авторизацию
          loggedIn = await this.checkIfLoggedIn();
          if (!loggedIn) {
            throw new Error('Phone input field not found and user did not login manually within 60 seconds');
          } else {
            this.logger.log('User logged in! Continuing...');
            return;
          }
        }
        
        // Если все еще не нашли поле, но пользователь не авторизовался, выбрасываем ошибку
        if (!phoneInput && !loggedIn) {
          throw new Error('Phone input field not found on login page');
        }
      }

      // Вводим телефон
      // Нормализуем формат телефона (убираем пробелы, дефисы и т.д.)
      const normalizedPhone = phone.replace(/[\s\-\(\)]/g, '');
      this.logger.log(`Entering phone number: ${normalizedPhone} (original: ${phone})`);
      
      // Фокусируемся на поле и очищаем его
      await phoneInput.click({ clickCount: 3 });
      await this.page.waitForTimeout(500);
      
      // Пробуем очистить поле через клавиатуру
      await phoneInput.press('Backspace');
      await this.page.waitForTimeout(200);
      
      // Вводим телефон посимвольно с задержкой
      // Пробуем ввести как есть, если не получится - попробуем без плюса
      await phoneInput.type(normalizedPhone, { delay: 150 });
      await this.page.waitForTimeout(2000);
      
      // Проверяем, что телефон введен
      const enteredPhone = await this.page.evaluate((el) => (el as HTMLInputElement).value, phoneInput);
      this.logger.log(`Entered phone value: ${enteredPhone}`);
      
      if (!enteredPhone || enteredPhone.length < 5) {
        this.logger.warn('Phone was not entered correctly, trying again...');
        await phoneInput.click({ clickCount: 3 });
        // Пробуем ввести без плюса, если он был
        const phoneWithoutPlus = normalizedPhone.startsWith('+') ? normalizedPhone.substring(1) : normalizedPhone;
        await phoneInput.type(phoneWithoutPlus, { delay: 100 });
        await this.page.waitForTimeout(1000);
        
        // Проверяем еще раз
        const enteredPhone2 = await this.page.evaluate((el) => (el as HTMLInputElement).value, phoneInput);
        this.logger.log(`Entered phone value after retry: ${enteredPhone2}`);
      }

      // Ищем кнопку "Далее" или "Продолжить"
      const nextButtonSelectors = [
        'button[type="submit"]',
        'button[data-marker*="submit"]',
        'button.button-button-2Fo5k',
      ];

      // Пробуем найти кнопку через текст
      let nextButton = null;
      try {
        const buttons = await this.page.$$('button');
        for (const button of buttons) {
          const text = await this.page.evaluate(el => el.textContent, button);
          if (text && (text.includes('Далее') || text.includes('Продолжить') || text.includes('Continue'))) {
            nextButton = button;
            this.logger.log('Found next button by text');
            break;
          }
        }
      } catch (e) {
        this.logger.warn('Error searching for next button by text:', e);
      }

      // Если не нашли по тексту, пробуем селекторы
      if (!nextButton) {
        for (const selector of nextButtonSelectors) {
          try {
            nextButton = await this.page.$(selector);
            if (nextButton) {
              this.logger.log(`Found next button with selector: ${selector}`);
              break;
            }
          } catch (e) {
            continue;
          }
        }
      }

      if (nextButton) {
        await nextButton.click();
        this.logger.log('Clicked next/continue button');
        await this.page.waitForTimeout(3000);
      } else {
        // Пробуем нажать Enter на поле телефона
        await phoneInput.press('Enter');
        this.logger.log('Pressed Enter on phone field');
        await this.page.waitForTimeout(3000);
      }

      // Вводим пароль
      this.logger.log('Entering password...');
      
      // Ждем появления поля пароля
      await this.page.waitForTimeout(2000);
      
      // Пробуем найти поле пароля разными способами
      let passwordInput: puppeteer.ElementHandle<Element> | null = await this.page.$('input[type="password"]');
      
      if (!passwordInput) {
        // Пробуем другие селекторы
        const passwordSelectors = [
          'input[type="password"]',
          'input[name*="password"]',
          'input[name*="Password"]',
          'input[id*="password"]',
          'input[placeholder*="пароль"]',
          'input[placeholder*="Пароль"]',
          'input[autocomplete="current-password"]',
        ];
        
        for (const selector of passwordSelectors) {
          try {
            passwordInput = await this.page.$(selector);
            if (passwordInput) {
              const isVisible = await this.page.evaluate((el) => {
                const htmlEl = el as HTMLElement;
                return htmlEl.offsetWidth > 0 && htmlEl.offsetHeight > 0;
              }, passwordInput);
              if (isVisible) {
                this.logger.log(`Found password input with selector: ${selector}`);
                break;
              }
            }
          } catch (e) {
            continue;
          }
        }
      }
      
      if (!passwordInput) {
        // Может быть уже авторизовались или нужен код подтверждения
        this.logger.warn('Password input not found, checking if already logged in...');
        await this.page.waitForTimeout(3000);
        const url = this.page.url();
        if (url.includes('/profile') || url.includes('/cabinet') || url.includes('/messenger')) {
          this.logger.log('Already logged in after phone entry');
          return;
        }
        
        // Проверяем, не появилось ли поле для кода подтверждения
        const codeInput = await this.page.$('input[type="text"], input[type="number"]');
        if (codeInput) {
          const placeholder = await this.page.evaluate((el) => (el as HTMLInputElement).placeholder, codeInput);
          if (placeholder && (placeholder.includes('код') || placeholder.includes('code'))) {
            this.logger.warn('SMS code input detected. Manual intervention may be required.');
            throw new Error('SMS code verification required. Please check the browser window.');
          }
        }
        
        throw new Error('Password input field not found');
      }

      // Вводим пароль
      await passwordInput.click({ clickCount: 3 });
      await this.page.waitForTimeout(300);
      await passwordInput.type(password, { delay: 100 });
      await this.page.waitForTimeout(1500);

      // Нажимаем кнопку входа
      const submitButtonSelectors = [
        'button[type="submit"]',
        'button[data-marker*="submit"]',
      ];

      let submitButton = null;
      
      // Пробуем найти по тексту
      try {
        const buttons = await this.page.$$('button');
        for (const button of buttons) {
          const text = await this.page.evaluate(el => el.textContent, button);
          if (text && (text.includes('Войти') || text.includes('Вход') || text.includes('Login'))) {
            submitButton = button;
            this.logger.log('Found submit button by text');
            break;
          }
        }
      } catch (e) {
        this.logger.warn('Error searching for submit button by text:', e);
      }

      // Если не нашли по тексту, пробуем селекторы
      if (!submitButton) {
        for (const selector of submitButtonSelectors) {
          try {
            submitButton = await this.page.$(selector);
            if (submitButton) {
              this.logger.log(`Found submit button with selector: ${selector}`);
              break;
            }
          } catch (e) {
            continue;
          }
        }
      }

      if (submitButton) {
        await submitButton.click();
        this.logger.log('Clicked submit/login button');
      } else {
        // Пробуем нажать Enter
        await passwordInput.press('Enter');
        this.logger.log('Pressed Enter on password field');
      }

      // Ждём завершения авторизации
      this.logger.log('Waiting for login to complete...');
      try {
        await this.page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 });
      } catch (e) {
        // Иногда навигация не происходит, но мы уже на нужной странице
        this.logger.warn('Navigation timeout, but continuing...');
        await this.page.waitForTimeout(3000);
      }
      
      // Проверяем, что авторизация прошла успешно
      await this.page.waitForTimeout(2000);
      const isLoggedIn = await this.checkIfLoggedIn();
      
      if (!isLoggedIn) {
        this.logger.warn('Login may not have completed successfully, waiting and checking again...');
        // Ждем еще немного и проверяем снова
        await this.page.waitForTimeout(5000);
        const isLoggedInRetry = await this.checkIfLoggedIn();
        
        if (!isLoggedInRetry) {
          const url = this.page.url();
          this.logger.log(`Current URL: ${url}`);
          this.logger.warn('Login verification failed, but continuing - user may have logged in manually');
        } else {
          this.logger.log('Login verified successfully on retry');
        }
      } else {
        this.logger.log('Login verified successfully');
      }

      this.logger.log('Login process completed');
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
      
      throw error;
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
