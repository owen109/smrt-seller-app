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

type LabelSize = '1 x 2.125' | '2.25 x 1.25' | '1 x 3.5' | 'CUSTOM';


type CustomLabelSize = {
  width: number;  // in inches
  height: number; // in inches
};

type AutomationStatus = {
    id: string;
    status: 'running' | 'paused' | 'error' | 'completed';
    message?: string;
    progress?: number;
    details?: {
        sku?: string;
        asin?: string;
        price?: number;
        condition?: string;
        conditionNotes?: string;
    };
}

type AutomationRequest = {
    type: 'inventory' | 'orders' | 'createListing';
    params?: {
        asin?: string;
        sku?: string;
        price?: number;
        condition?: 'Used - Like New' | 'Used - Very Good' | 'Used - Good' | 'Used - Acceptable';
        conditionNotes?: string;
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
    labelSize: LabelSize;
    customSize?: CustomLabelSize;  // Only used when labelSize is 'CUSTOM'
    orientation?: 'portrait' | 'landscape';  // New property for print orientation
}

// Update PrintOptions type to match Electron's WebContentsPrintOptions
interface PrintOptions {
    silent?: boolean;
    printBackground?: boolean;
    deviceName?: string;
    color?: boolean;
    margins?: {
        marginType?: 'default' | 'none' | 'printableArea' | 'custom';
        top?: number;
        bottom?: number;
        left?: number;
        right?: number;
    };
    landscape?: boolean;
    scaleFactor?: number;
    pagesPerSheet?: number;
    collate?: boolean;
    copies?: number;
    pageRanges?: Array<{
        from: number;
        to: number;
    }>;
    headerFooter?: {
        title?: string;
        url?: string;
        date?: string;
    };
    duplexMode?: 'simplex' | 'shortEdge' | 'longEdge';
    dpi?: {
        horizontal: number;
        vertical: number;
    };
}

// REGISTERED EVENTS
type EventPayloadMapping = {
    statistics: Statistics;
    getStaticData: StaticData;
    changeView: View;
    sendFrameAction: FrameWindowAction;
    startAutomation: string; // Returns automation ID
    automationStatus: AutomationStatus;
    activeAutomationsCount: number; // Number of active automations
    getSetupStatus: SetupStatus;
    startSetup: string; // Returns automation ID
    completeSetup: void;
    getLogs: string;
    getPrinters: PrinterInfo[];
    getPrintSettings: PrintSettings;
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
        subscribeActiveAutomationsCount: (callback: (count: number) => void) => UnsubscribeFunction;
        getSetupStatus: () => Promise<SetupStatus>;
        startSetup: () => Promise<string>;
        completeSetup: () => Promise<void>;
        getLogs: () => Promise<string>;
        getPrinters: () => Promise<PrinterInfo[]>;
        getPrintSettings: () => Promise<PrintSettings>;
        testPrint: (settings: PrintSettings) => Promise<boolean>;
    };
}

type ListingResult = {
    fnsku: string;
    duration: number;
    success: boolean;
    error?: string;
}

type PendingAutomation = {
    request: AutomationRequest;
    startTime: number;
    retryCount: number;
}

type ReauthenticationStatus = {
    isReauthenticating: boolean;
    pendingAutomations: PendingAutomation[];
    lastAttempt?: number;
}

// Update AutomationManager state in types
interface AutomationManagerState {
    isConfigured: boolean;
    lastLogin?: string;
    reauthStatus?: ReauthenticationStatus;
}