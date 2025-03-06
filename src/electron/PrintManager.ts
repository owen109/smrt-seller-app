import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
const execPromise = promisify(exec);

export class PrintManager {
    private isElectron: boolean;

    constructor() {
        this.isElectron = process.versions.hasOwnProperty('electron');
    }

    async getAvailablePrinters(): Promise<string[]> {
        try {
            const { stdout } = await execPromise('lpstat -a');
            return stdout.split('\n')
                .filter((line: string) => line.trim())
                .map((line: string) => {
                    const printerName = line.split(' ')[0];
                    return printerName;
                });
        } catch (error) {
            console.error('Error getting printers:', error);
            return [];
        }
    }

    async printLabel(printerName: string, pdfPath: string, quantity: number = 1): Promise<boolean> {
        try {
            console.log('\n=== Print Request Details ===');
            console.log('Printer Name:', printerName);
            console.log('PDF Path:', pdfPath);
            console.log('Quantity:', quantity);

            // Base command without -n parameter
            const command = `lp -d "${printerName}" -o landscape -o orientation-requested=5 -o scaling=100 -o media=Custom.1x2.125in "${pdfPath}"`;
            
            console.log('Print Command (will execute', quantity, 'times):', command);
            
            // Loop over the print command for the specified quantity
            for (let i = 1; i <= quantity; i++) {
                console.log(`\nExecuting print ${i} of ${quantity}`);
                const { stdout, stderr } = await execPromise(command);
                
                if (stderr) {
                    console.error(`Print error on copy ${i}:`, stderr);
                    return false;
                }
                
                console.log(`Print job ${i} sent successfully!`);
                console.log('Print job details:', stdout);
            }

            console.log('=== End Print Request - All copies completed ===\n');
            return true;

        } catch (error) {
            console.error('Error occurred:', error);
            return false;
        }
    }

    async isPrinterAvailable(printerName: string): Promise<boolean> {
        try {
            const { stdout } = await execPromise(`lpstat -p ${printerName}`);
            return stdout.includes(printerName);
        } catch (error) {
            return false;
        }
    }
}

// For testing the module directly
if (import.meta.url === `file://${process.argv[1]}`) {
    const printer = new PrintManager();
    
    async function run() {
        console.log('Available printers:');
        const printers = await printer.getAvailablePrinters();
        printers.forEach(p => console.log('-', p));

        const dymoAvailable = await printer.isPrinterAvailable('DYMO_LabelWriter_450');
        if (dymoAvailable) {
            console.log('DYMO printer found, printing test label...');
            await printer.printLabel('DYMO_LabelWriter_450', 'label.pdf');
        } else {
            console.log('DYMO printer not found or not ready');
        }
    }

    run().catch(console.error);
} 