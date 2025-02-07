// TYPES
type Statistics = {
    cpuUsage: number;
    ramUsage: number;
    storageUsage: number;
}

type StaticData = {
    totalStorage: number;
    cpuModel: string;
    totatlMemoryGB: number;
}

type View = "CPU" | "RAM" | "STORAGE";

type FrameWindowAction = "CLOSE" | "MINIMIZE" | "MAXIMIZE";

type AutomationStatus = {
    id: string;
    status: 'running' | 'paused' | 'error' | 'completed';
    message?: string;
    progress?: number;
    details?: {
        sku?: string;
        asin?: string;
    };
}

type AutomationRequest = {
    type: 'inventory' | 'orders' | 'createListing';
    params?: {
        asin?: string;
        sku?: string;
        price?: number;
        condition?: 'Used - Like New' | 'Used - Very Good' | 'Used - Good' | 'Used - Acceptable';
    };
}

type SetupStatus = {
    isConfigured: boolean;
    lastLogin?: string;
}

type PrinterInfo = {
    name: string;
    description?: string;
    status: string;
    isDefault: boolean;
}

type PrintSettings = {
    printer: string;
    copies?: number;
    color?: boolean;
    duplex?: boolean;
}

// REGISTERED EVENTS
type EventPayloadMapping = {
    statistics: Statistics;
    getStaticData: StaticData;
    changeView: View;
    sendFrameAction: FrameWindowAction;
    startAutomation: string; // Returns automation ID
    automationStatus: AutomationStatus;
    getSetupStatus: SetupStatus;
    startSetup: string; // Returns automation ID
    completeSetup: void;
    getLogs: string;
    getPrinters: PrinterInfo[];
    testPrint: boolean;
}

type UnsubscribeFunction = () => void;

// WINDOW
interface Window {
    electron: {
        subscribeStatistics: (callback: (statistics: Statistics) => void) => UnsubscribeFunction;
        getStaticData: () => Promise<StaticData>;
        subscribeChangeView: (callback: (view: View) => void) => UnsubscribeFunction;
        sendFrameAction: (payload: FrameWindowAction) => void;
        startAutomation: (request: AutomationRequest) => Promise<string>;
        subscribeAutomationStatus: (callback: (status: AutomationStatus) => void) => UnsubscribeFunction;
        getSetupStatus: () => Promise<SetupStatus>;
        startSetup: () => Promise<string>;
        completeSetup: () => Promise<void>;
        getLogs: () => Promise<string>;
        getPrinters: () => Promise<PrinterInfo[]>;
        testPrint: (settings: PrintSettings) => Promise<boolean>;
    };
}

type ListingResult = {
    fnsku: string;
    duration: number;
    success: boolean;
    error?: string;
}