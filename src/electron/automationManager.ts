import { firefox, Browser, Page } from 'playwright';
import path from 'path';
import { app } from 'electron';
import { v4 as uuidv4 } from 'uuid';
import { ipcWebContentsSend } from './util.js';
import { BrowserWindow } from 'electron';
import fs from 'fs/promises';

// Create a logging utility
const log = {
    info: (message: string, ...args: any[]) => {
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] INFO: ${message}`;
        console.log(logMessage, ...args);
        writeToLogFile(logMessage + (args.length ? ' ' + JSON.stringify(args) : ''));
    },
    error: (message: string, error?: any) => {
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] ERROR: ${message}${error ? ` - ${error.message || error}` : ''}`;
        console.error(logMessage);
        writeToLogFile(logMessage + (error?.stack ? '\n' + error.stack : ''));
    }
};

async function writeToLogFile(message: string) {
    const logPath = path.join(app.getPath('userData'), 'logs');
    const logFile = path.join(logPath, `automation-${new Date().toISOString().split('T')[0]}.log`);
    
    try {
        await fs.mkdir(logPath, { recursive: true });
        await fs.appendFile(logFile, message + '\n');
    } catch (error) {
        console.error('Failed to write to log file:', error);
    }
}

type RunningAutomation = {
    id: string;
    browser: Browser;
    page: Page;
    status: AutomationStatus;
    result?: {
        fnsku?: string;
        error?: string;
    };
}

class AutomationManager {
    private runningAutomations: Map<string, RunningAutomation> = new Map();
    private mainWindow: BrowserWindow;
    private profilesPath: string;
    private configPath: string;

    constructor(mainWindow: BrowserWindow) {
        this.mainWindow = mainWindow;
        // Use the app's user data directory in production
        const baseDir = app.isPackaged 
            ? app.getPath('userData')
            : process.cwd();
        
        this.profilesPath = path.join(baseDir, 'profiles');
        this.configPath = path.join(this.profilesPath, 'config.json');
        
        log.info('Initializing AutomationManager', {
            baseDir,
            profilesPath: this.profilesPath,
            configPath: this.configPath,
            isPackaged: app.isPackaged
        });
        
        this.initializeDirectories();
    }

    private async initializeDirectories() {
        try {
            log.info('Creating profile directories');
            
            // Create profiles directory
            await fs.mkdir(this.profilesPath, { recursive: true });
            
            // Create default profile directory
            const defaultProfilePath = path.join(this.profilesPath, 'default');
            await fs.mkdir(defaultProfilePath, { recursive: true });
            
            // Create empty cookies.sqlite if it doesn't exist
            const cookiesPath = path.join(defaultProfilePath, 'cookies.sqlite');
            try {
                await fs.access(cookiesPath);
                log.info('cookies.sqlite already exists');
            } catch {
                log.info('Creating empty cookies.sqlite');
                await fs.writeFile(cookiesPath, '');
            }

            log.info('Directory initialization complete', {
                profilesPath: this.profilesPath,
                defaultProfilePath: defaultProfilePath,
                cookiesPath: cookiesPath
            });
        } catch (error) {
            log.error('Failed to create profile directories:', error);
        }
    }

    private async saveConfig(config: SetupStatus) {
        try {
            log.info('Saving config', config);
            await fs.writeFile(this.configPath, JSON.stringify(config, null, 2));
        } catch (error) {
            log.error('Failed to save config:', error);
        }
    }

    async getSetupStatus(): Promise<SetupStatus> {
        try {
            const data = await fs.readFile(this.configPath, 'utf-8');
            const config = JSON.parse(data) as SetupStatus;
            log.info('Retrieved setup status', config);
            return config;
        } catch (error) {
            log.info('No config found, returning default status');
            return { isConfigured: false };
        }
    }

    private updateAutomationStatus(automation: RunningAutomation, update: Partial<AutomationStatus>) {
        automation.status = { ...automation.status, ...update };
        log.info('Updating automation status', {
            automationId: automation.id,
            status: automation.status
        });
        ipcWebContentsSend('automationStatus', this.mainWindow.webContents, automation.status);
    }

    async startSetup(): Promise<string> {
        const id = uuidv4();
        const defaultProfilePath = path.join(this.profilesPath, 'default');

        const browser = await firefox.launch({
            headless: false,
            firefoxUserPrefs: {
                'browser.sessionstore.resume_from_crash': false,
                'browser.sessionstore.max_resumed_crashes': 0
            }
        });

        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:122.0) Gecko/20100101 Firefox/122.0',
            viewport: { width: 1920, height: 1080 },
            screen: { width: 1920, height: 1080 }
        });

        const page = await context.newPage();
        
        const automation: RunningAutomation = {
            id,
            browser,
            page,
            status: {
                id,
                status: 'running',
                progress: 0
            }
        };

        this.runningAutomations.set(id, automation);
        
        try {
            this.updateAutomationStatus(automation, {
                message: 'Opening Amazon Seller Central...',
                progress: 20
            });

            await page.goto('https://sellercentral.amazon.com/');
            
            this.updateAutomationStatus(automation, {
                message: 'Please log in to Seller Central. Click "Complete Setup" when finished.',
                progress: 50
            });

            return id;

        } catch (error) {
            console.error('Setup error:', error);
            const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
            
            if (this.runningAutomations.has(id)) {
                this.updateAutomationStatus(automation, {
                    status: 'error',
                    message: `Setup failed: ${errorMessage}`
                });
            }
            
            await this.cleanupAutomation(id);
            throw error;
        }
    }

    private async cleanupAutomation(id: string) {
        const automation = this.runningAutomations.get(id);
        if (automation) {
            log.info('Cleaning up automation', { id });
            try {
                if (!automation.browser.isConnected()) {
                    log.info('Browser already disconnected', { id });
                    this.runningAutomations.delete(id);
                    return;
                }
                
                // Close browser immediately - this will automatically close all pages and contexts
                await automation.browser.close()
                    .catch(e => log.error('Error closing browser:', e));
                
                log.info('Successfully cleaned up automation', { id });
            } catch (error) {
                log.error('Error during cleanup:', error);
            } finally {
                this.runningAutomations.delete(id);
            }
        }
    }

    // Add a timeout to automations
    private setupAutomationTimeout(automation: RunningAutomation, timeoutMs: number = 5 * 60 * 1000) {
        setTimeout(async () => {
            if (this.runningAutomations.has(automation.id)) {
                log.error('Automation timed out', { id: automation.id });
                this.updateAutomationStatus(automation, {
                    status: 'error',
                    message: 'Automation timed out'
                });
                await this.cleanupAutomation(automation.id);
            }
        }, timeoutMs);
    }

    async getCurrentSetupId(): Promise<string> {
        const currentSetup = Array.from(this.runningAutomations.entries())
            .find(([_, automation]) => automation.status.status === 'running');
        
        if (!currentSetup) {
            throw new Error('No active setup session found');
        }

        return currentSetup[0];
    }

    async completeSetup(automationId: string): Promise<void> {
        const automation = this.runningAutomations.get(automationId);
        if (!automation) {
            throw new Error('Setup session not found');
        }

        try {
            // Try to save the browser state
            const context = automation.page.context();
            await context.storageState({ 
                path: path.join(this.profilesPath, 'storage.json') 
            });

            // Save setup status
            await this.saveConfig({
                isConfigured: true,
                lastLogin: new Date().toISOString()
            });

            this.updateAutomationStatus(automation, {
                message: 'Setup completed successfully',
                progress: 100,
                status: 'completed'
            });

            // Cleanup immediately
            await this.cleanupAutomation(automationId);

        } catch (error) {
            console.error('Complete setup error:', error);
            // Cleanup immediately on error
            await this.cleanupAutomation(automationId);
            throw error;
        }
    }

    async startAutomation(request: AutomationRequest): Promise<string> {
        // Check if setup is completed
        const setupStatus = await this.getSetupStatus();
        if (!setupStatus.isConfigured) {
            throw new Error('Please complete setup first');
        }

        const id = uuidv4();

        const browser = await firefox.launch({
            headless: false,
            firefoxUserPrefs: {
                'dom.webdriver.enabled': false,
                'privacy.trackingprotection.enabled': false,
                'network.cookie.cookieBehavior': 0,
                'geo.provider.network.url': 'https://location.services.mozilla.com/v1/geolocate?key=%MOZILLA_API_KEY%',
                'geo.provider.use_gpsd': false,
                'geo.provider.use_geoclue': false,
                'intl.accept_languages': 'en-US, en',
                'privacy.resistFingerprinting': false,
                'webgl.disabled': false,
                'dom.storage.enabled': true,
                'dom.indexedDB.enabled': true,
                // Keep existing performance optimizations
                'browser.cache.disk.enable': false,
                'browser.cache.memory.enable': true,
                'browser.cache.memory.capacity': 524288,
                'browser.sessionhistory.max_entries': 0,
                'network.http.max-persistent-connections-per-server': 10,
                'network.http.max-connections': 50,
                'content.notify.interval': 500000,
                'content.switch.threshold': 250000,
                'nglayout.initialpaint.delay': 0,
                'dom.ipc.processCount': 1,
                'javascript.options.mem.gc_incremental_slice_ms': 1,
                // Add aggressive startup optimizations
                'browser.startup.homepage': 'about:blank',
                'browser.startup.page': 0,
                'browser.sessionstore.enabled': false,
                'extensions.enabledScopes': 0,
                'security.fileuri.strict_origin_policy': false,
                'browser.shell.checkDefaultBrowser': false,
                'browser.newtabpage.enabled': false,
                'browser.newtab.preload': false,
                'browser.aboutConfig.showWarning': false,
                'gfx.canvas.accelerated': false,
                'layers.acceleration.disabled': true,
                'media.hardware-video-decoding.enabled': false,
                'network.dns.disableIPv6': true,
                'network.proxy.type': 0,
                'permissions.default.geo': 2,
                'dom.serviceWorkers.enabled': false,
                'dom.push.enabled': false,
                'browser.download.manager.retention': 0,
                'browser.helperApps.deleteTempFileOnExit': true,
                'browser.uitour.enabled': false,
                'toolkit.telemetry.enabled': false,
                'browser.ping-centre.telemetry': false,
                'browser.discovery.enabled': false
            }
        });

        const context = await browser.newContext({
            storageState: path.join(this.profilesPath, 'storage.json'),
            viewport: { width: 1920, height: 1080 },
            screen: { width: 1920, height: 1080 }
        });

        const page = await context.newPage();
        
        const automation: RunningAutomation = {
            id,
            browser,
            page,
            status: {
                id,
                status: 'running',
                progress: 0,
                details: {
                    sku: request.params?.sku,
                    asin: request.params?.asin
                }
            }
        };

        this.runningAutomations.set(id, automation);
        
        // Set up timeout
        this.setupAutomationTimeout(automation);
        
        // Start the automation in background
        this.runAutomation(automation, request).catch((error: Error) => {
            this.updateAutomationStatus(automation, {
                status: 'error',
                message: error.message
            });
            this.cleanupAutomation(automation.id);
        });

        return id;
    }

    private async runAutomation(automation: RunningAutomation, request: AutomationRequest) {
        try {
            switch (request.type) {
                case 'inventory':
                    await this.handleInventory(automation);
                    break;
                case 'orders':
                    await this.handleOrders(automation);
                    break;
                case 'createListing':
                    await this.handleCreateListing(automation, request.params);
                    break;
            }

            this.updateAutomationStatus(automation, {
                status: 'completed',
                progress: 100
            });

            // Cleanup immediately
            await this.cleanupAutomation(automation.id);

        } catch (error) {
            log.error('Automation failed', error);
            this.updateAutomationStatus(automation, {
                status: 'error',
                message: error instanceof Error ? error.message : 'Unknown error occurred'
            });
            // Cleanup immediately on error
            await this.cleanupAutomation(automation.id);
            throw error;
        }
    }

    private async handleInventory(automation: RunningAutomation) {
        // TODO: Implement inventory automation
    }

    private async handleOrders(automation: RunningAutomation) {
        // TODO: Implement orders automation
    }

    private async handleCreateListing(automation: RunningAutomation, params?: AutomationRequest['params']) {
        if (!params?.asin || !params?.sku || !params?.price) {
            throw new Error('Missing required parameters for listing creation');
        }

        const { page } = automation;
        const startTime = Date.now();

        try {
            this.updateAutomationStatus(automation, {
                message: 'Navigating to listing creation page...',
                progress: 20
            });

            // Navigate to the listing creation page
            await page.goto(`https://sellercentral.amazon.com/abis/listing/syh/offer?asin=${params.asin}`, {
                waitUntil: 'domcontentloaded',
                timeout: 30000
            });

            // Check if we're on a login page
            const isLoginPage = page.url().includes('signin') || 
                              await page.locator('input[type="password"]').count() > 0;
            
            if (isLoginPage) {
                this.updateAutomationStatus(automation, {
                    message: 'Login required. Please check the browser window.',
                    progress: 30
                });
                // Wait for user to handle login
                await page.waitForURL((url) => !url.toString().includes('signin'), { timeout: 300000 });
            }

            this.updateAutomationStatus(automation, {
                message: 'Filling listing details...',
                progress: 50
            });
            // Fill form fields
            await page.getByRole('textbox', { name: 'Seller SKU' }).fill(params.sku);
            await page.getByRole('textbox', { name: 'Your Price' }).fill(params.price.toString());
            await page.getByRole('textbox', { name: 'List Price' }).fill((params.price * 1.5).toString());

            // Set condition if provided
            if (params.condition) {
                const dropdown = page.locator('div[part="dropdown-header"]');
                await dropdown.click();
                await new Promise(resolve => setTimeout(resolve, 250));
                console.log('1 second passed');
                const option = page.getByText(params.condition, { exact: false });
                await option.click();
            }

            this.updateAutomationStatus(automation, {
                message: 'Submitting listing...',
                progress: 75
            });

            // Submit the listing
            await page.getByRole('button', { name: 'Save and finish' }).click();
      
            // Wait for the Convert button to be clickable
            await page.getByTestId('button-label-for-SC_FBA_LFBA_1_PAGE_LIST_AS_FBA_BUTTON_CONVERTANDSEND').waitFor({ state: 'visible' });
            await page.getByTestId('button-label-for-SC_FBA_LFBA_1_PAGE_LIST_AS_FBA_BUTTON_CONVERTANDSEND').click();

            console.log('Getting FNSKU...');
            const fnskuElement = page.getByTestId('fnsku');
            const fnsku = await fnskuElement.textContent();
            const fnskuValue = fnsku?.match(/X0[A-Z0-9]{8}/)?.[0] || '';
            console.log('Listing created successfully FNSKU:', fnskuValue);
            if (!fnskuValue) {
                throw new Error('Could not extract valid FNSKU from page');
            }

            // Store the FNSKU in the automation result
            automation.result = { fnsku: fnskuValue };

            this.updateAutomationStatus(automation, {
                message: `Successfully created listing with FNSKU: ${fnskuValue}`,
                progress: 100
            });

        } catch (error) {
            console.error('Error in listing creation:', error);
            if (!page.isClosed()) {
                await page.screenshot({ path: path.join(this.profilesPath, `error_${Date.now()}.png`) });
            }
            // Store the error in the automation result
            automation.result = { error: error instanceof Error ? error.message : 'Unknown error occurred' };
            throw error;
        }
    }

    // Add a method to get automation result
    async getAutomationResult(id: string): Promise<RunningAutomation['result'] | null> {
        const automation = this.runningAutomations.get(id);
        if (!automation) {
            return null; // Return null instead of throwing
        }
        return automation.result;
    }
}

export function createAutomationManager(mainWindow: BrowserWindow) {
    return new AutomationManager(mainWindow);
} 