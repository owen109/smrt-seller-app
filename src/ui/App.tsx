import { useState, useEffect } from 'react'
import './App.css'
import logo from './assets/SMRT_Seller_Text.png'

type AutomationDisplay = {
  [id: string]: AutomationStatus;
};

function App() {
  const [setupStatus, setSetupStatus] = useState<SetupStatus | null>(null);
  const [isSettingUp, setIsSettingUp] = useState(false);
  const [currentSetupId, setCurrentSetupId] = useState<string | null>(null);
  const [automations, setAutomations] = useState<AutomationDisplay>({});
  const [printers, setPrinters] = useState<PrinterInfo[]>([]);
  const [selectedPrinter, setSelectedPrinter] = useState<string>('');
  const [printSettings, setPrintSettings] = useState<PrintSettings>({
    printer: '',
    copies: 1,
    color: false,
    duplex: false,
    labelSize: 'STANDARD'
  });
  const [isPrinterExpanded, setIsPrinterExpanded] = useState(false);

  useEffect(() => {
    // Get initial setup status
    window.electron.getSetupStatus().then(setSetupStatus);

    // Subscribe to automation status updates
    const unsubscribe = window.electron.subscribeAutomationStatus((status) => {
      setAutomations(prev => {
        if (status.status === 'completed' || status.status === 'error') {
          // Remove completed/errored automations after 5 seconds
          setTimeout(() => {
            setAutomations(prev => {
              const { [status.id]: _, ...rest } = prev;
              return rest;
            });
          }, 5000);
        }
        return { ...prev, [status.id]: status };
      });

      if (status.status === 'completed' || status.status === 'error') {
        // Refresh setup status after automation completes
        window.electron.getSetupStatus().then(setSetupStatus);
        setIsSettingUp(false);
      }
    });

    // Load available printers
    window.electron.getPrinters().then(printers => {
      setPrinters(printers);
      const defaultPrinter = printers.find(p => p.isDefault);
      if (defaultPrinter) {
        setSelectedPrinter(defaultPrinter.name);
        // Load the current print settings
        window.electron.getPrintSettings().then(savedSettings => {
          setPrintSettings(savedSettings);
          console.log('Loaded saved print settings:', savedSettings);
        });
      }
    });

    return () => unsubscribe();
  }, []);

  const handleStartSetup = async () => {
    setIsSettingUp(true);
    try {
      const automationId = await window.electron.startSetup();
      setCurrentSetupId(automationId);
    } catch (error) {
      console.error('Setup failed:', error);
      setIsSettingUp(false);
      // Show error message to user
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      dialog.showErrorBox('Setup Failed', 
        `${errorMessage}\n\nPlease ensure:\n` +
        '1. Firefox is installed and up to date\n' +
        '2. You have a stable internet connection\n' +
        '3. Your system meets the minimum requirements\n\n' +
        'If the problem persists, please try restarting the application.'
      );
    }
  };

  const handleCompleteSetup = async () => {
    if (!currentSetupId) return;
    
    try {
      await window.electron.completeSetup();
      // Status will be updated via the automation status subscription
    } catch (error) {
      console.error('Failed to complete setup:', error);
    }
  };

  const handleTestPrint = async () => {
    if (!selectedPrinter) {
      alert('Please select a printer first');
      return;
    }
    
    try {
      const success = await window.electron.testPrint(printSettings);
      if (!success) {
        alert('Print failed. Please check printer connection and try again.');
      }
    } catch (error) {
      console.error('Print error:', error);
      alert('Print failed. Please check printer connection and try again.');
    }
  };

  const handleLabelSizeChange = async (newSize: LabelSize) => {
    console.log('Changing label size to:', newSize);
    // First update local state
    setPrintSettings(prev => {
      const updated = { ...prev, labelSize: newSize };
      console.log('Updated print settings:', updated);
      return updated;
    });

    // Then update server settings with a single call (copies=0 to prevent actual printing)
    try {
      await window.electron.testPrint({ 
        ...printSettings, 
        labelSize: newSize,
        copies: 0 
      });
      console.log('Saved label size:', newSize);
    } catch (error) {
      console.error('Failed to update print settings:', error);
    }
  };

  if (!setupStatus) {
    return <div className="App">
      <div className="app-header">
        <img src={logo} alt="SMRT Seller Logo" className="app-logo" />
      </div>
      Loading...
    </div>;
  }

  if (!setupStatus.isConfigured) {
    return (
      <div className="App">
        <div className="app-header">
          <img src={logo} alt="SMRT Seller Logo" className="app-logo" />
        </div>
        <div className="setup-container">
          <h2>Welcome to SMRT Seller</h2>
          <p>Before you can use the app, you need to set up your Amazon Seller Central account.</p>
          {!isSettingUp ? (
            <button 
              onClick={handleStartSetup}
              className="setup-button"
            >
              Start Setup
            </button>
          ) : (
            <p className="setup-info">
              Please log in to your Seller Central account in the browser window that opened.<br/>
              The setup will complete automatically once you're logged in.
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="App">
      <div className="app-header">
        <img src={logo} alt="SMRT Seller Logo" className="app-logo" />
      </div>
      <div className="main">
        <h2>Ready to automate!</h2>
        <p>Your Seller Central account is connected.</p>
        
        {/* Printer Settings */}
        <div className="printer-settings">
          <div className="printer-controls">
            <span className="printer-label">Printer:</span>
            <select 
              value={selectedPrinter}
              onChange={(e) => {
                setSelectedPrinter(e.target.value);
                setPrintSettings(prev => ({ ...prev, printer: e.target.value }));
              }}
              className="printer-select"
            >
              {selectedPrinter ? (
                printers.map(printer => (
                  <option key={printer.name} value={printer.name}>
                    {printer.name} {printer.isDefault ? '(Default)' : ''}
                  </option>
                ))
              ) : (
                <>
                  <option value="">Select printer</option>
                  {printers.map(printer => (
                    <option key={printer.name} value={printer.name}>
                      {printer.name} {printer.isDefault ? '(Default)' : ''}
                    </option>
                  ))}
                </>
              )}
            </select>

            <span className="printer-label">Label Size:</span>
            <select
              value={printSettings.labelSize}
              onChange={(e) => handleLabelSizeChange(e.target.value as LabelSize)}
              className="size-select"
            >
              <option value="STANDARD">Standard (2.625" x 1")</option>
              <option value="SMALL">Small (2.125" x 1")</option>
              <option value="LARGE">Large (3" x 2")</option>
            </select>

            <button 
              onClick={handleTestPrint}
              className="print-button"
              disabled={!selectedPrinter}
            >
              <svg className="print-icon" viewBox="0 0 24 24" fill="currentColor">
                <path d="M19 8H5c-1.66 0-3 1.34-3 3v6h4v4h12v-4h4v-6c0-1.66-1.34-3-3-3zm-3 11H8v-5h8v5zm3-7c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1zm-1-9H6v4h12V3z"/>
              </svg>
              Test Print
            </button>
          </div>
        </div>

        {/* Automation Status Display */}
        <div className="automation-list">
          {Object.entries(automations).map(([id, status]) => {
            const displayId = status.details?.sku && status.details?.asin 
              ? `${status.details.sku} (${status.details.asin})`
              : `Automation #${id.slice(0, 8)}`;

            return (
              <div key={id} className="automation-item">
                <div className="automation-header">
                  <span className="automation-title">
                    {displayId}
                  </span>
                  <span className={`automation-status ${status.status}`}>
                    {status.status.toUpperCase()}
                  </span>
                </div>
                <div className="progress-container">
                  <div 
                    className="progress-bar" 
                    style={{ width: `${status.progress || 0}%` }}
                  />
                </div>
                {status.message && (
                  <p className="automation-message">{status.message}</p>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  )
}

export default App
