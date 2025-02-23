// @ts-nocheck
import bwipjs from 'bwip-js';
import { jsPDF } from 'jspdf';
import path from 'path';
import { app } from 'electron';
import { promises as fs } from 'fs';

// Custom error class for label generation errors
export class LabelGenerationError extends Error {
    constructor(message: string, public readonly cause?: unknown) {
        super(message);
        this.name = 'LabelGenerationError';
    }
}

// Standard label sizes in mm (based on Amazon's specifications)
export const LABEL_SIZES = {
    STANDARD: { width: 66.7, height: 25.4 },    // 2.625" x 1" (Amazon standard)
    SMALL: { width: 54.0, height: 25.4 },       // 2.125" x 1" (minimum)
    LARGE: { width: 76.2, height: 50.8 },       // 3" x 2" (maximum)
    CUSTOM: { width: 66.7, height: 25.4 }       // Default custom size, will be overridden
} as const;

export type LabelSize = keyof typeof LABEL_SIZES;

export interface LabelData {
    fnsku: string;
    sku: string;
    asin: string;
    title?: string;
    condition?: string;
    labelSize?: LabelSize;
    customSize?: CustomLabelSize;  // Add custom size support
}

/**
 * Gets the appropriate temporary directory path for label storage
 * @throws {LabelGenerationError} If unable to determine temp directory
 */
function getLabelTempDir(): string {
    try {
        // In production, use the app's user data directory
        if (app.isPackaged) {
            return path.join(
                app.getPath('userData'),
                'labels'
            );
        }

        // In development, use the system temp directory
        if (process.platform === 'win32') {
            const tempDir = process.env.TEMP;
            if (!tempDir) {
                throw new Error('TEMP environment variable not found on Windows');
            }
            return path.join(tempDir, 'smrt-seller-labels');
        } else {
            return path.join(app.getPath('temp'), 'smrt-seller-labels');
        }
    } catch (error) {
        throw new LabelGenerationError(
            'Failed to determine temporary directory for labels',
            error
        );
    }
}

/**
 * Generates a PDF label with FNSKU barcode and product information
 * @throws {LabelGenerationError} If label generation fails
 */
export async function generateLabel({
    fnsku,
    sku,
    asin,
    title = '',
    condition = '',
    labelSize = 'STANDARD',
    customSize
}: LabelData): Promise<string> {
    try {
        console.log('\nGenerating FNSKU label for ', fnsku);
        console.log('Platform:', process.platform);
        
        // Get dimensions based on label size or custom size
        let dimensions;
        if (labelSize === 'CUSTOM' && customSize) {
            // Convert inches to mm (1 inch = 25.4 mm)
            dimensions = {
                width: customSize.width * 25.4,
                height: customSize.height * 25.4
            };
            console.log('Using custom dimensions:', dimensions);
        } else {
            dimensions = LABEL_SIZES[labelSize];
            console.log('Using standard dimensions for', labelSize, ':', dimensions);
        }

        // Generate barcode buffer with improved settings
        const barcodeBuffer = await new Promise<Buffer>((resolve, reject) => {
            bwipjs.toBuffer({
                bcid: 'code128',
                text: fnsku,
                scale: 5,                    // Increased scale further for even higher resolution
                height: 10,                  // Increased height for better scanning
                includetext: true,
                textxalign: 'center',
                textsize: 7,                 // Slightly larger text for better readability
                width: dimensions.width * 0.85,  // Increased width to use more space
                backgroundcolor: 'ffffff',    // White background
                padding: 0,                   // No padding
                resolution: 600,              // Doubled DPI for much higher quality
                sizelimit: 0,                // Remove size limit
                guardwhitespace: true,       // Add white space guards
                inkspread: 0,                // Compensate for ink spread
                textyoffset: 2               // Adjust text position
            }, function (err, png) {
                if (err) reject(new LabelGenerationError('Failed to generate barcode', err));
                else resolve(png);
            });
        });

        // Create PDF with landscape orientation (wider than tall)
        const doc = new jsPDF({
            orientation: 'landscape',
            unit: 'mm',
            format: [dimensions.height, dimensions.width]  // Swapped for landscape
        });

        // Calculate positions for centered elements with reduced margins
        const margin = dimensions.width * 0.08;  // Reduced margin to 8% on sides
        const barcodeWidth = dimensions.width * 0.85;  // Increased to 85% of width
        const barcodeHeight = dimensions.height * 0.45;  // Kept same height
        const barcodeX = (dimensions.width - barcodeWidth) / 2;  // Center horizontally
        const barcodeY = dimensions.height * 0.15;  // Moved down slightly
        const textMargin = margin + 2;  // Add 2mm to text margin for better spacing

        try {
            // Add barcode centered
            doc.addImage(
                barcodeBuffer,
                'PNG',
                barcodeX,
                barcodeY,
                barcodeWidth,
                barcodeHeight
            );
        } catch (error) {
            throw new LabelGenerationError('Failed to add barcode to PDF', error);
        }

        // Set up text properties
        doc.setFontSize(5);  // Reduced font size for better fit
        doc.setFont('Helvetica', 'normal');
        
        // Calculate text positions with proper spacing
        const textStartY = dimensions.height * 0.70;  // Moved up slightly
        const lineHeight = 2;  // Reduced line height

        // Function to add text with proper spacing
        function addSpacedText(text: string, y: number) {
            try {
                const chars = text.split('');
                const charSpacing = 0.3;  // Reduced character spacing
                let currentX = textMargin;
                
                chars.forEach((char) => {
                    doc.text(char, currentX, y);
                    currentX += doc.getTextWidth(char) + charSpacing;
                });
            } catch (error) {
                throw new LabelGenerationError(`Failed to add text: ${text}`, error);
            }
        }

        // Add text lines with proper spacing (removed redundant FNSKU line)
        if (title) {
            addSpacedText(`Title: ${title.substring(0, 45)}${title.length > 45 ? '...' : ''}`, textStartY);
            addSpacedText(`ASIN: ${asin}`, textStartY + lineHeight);
            addSpacedText(`SKU: ${sku}`, textStartY + (lineHeight * 2));
            if (condition) {
                addSpacedText(`Condition: ${condition}`, textStartY + (lineHeight * 3));
            }
        } else {
            addSpacedText(`ASIN: ${asin}`, textStartY);
            addSpacedText(`SKU: ${sku}`, textStartY + lineHeight);
            if (condition) {
                addSpacedText(`Condition: ${condition}`, textStartY + (lineHeight * 2));
            }
        }

        // Get the appropriate temp directory
        const tempDir = getLabelTempDir();
        console.log('Using temp directory:', tempDir);

        // Create a unique filename with timestamp to avoid conflicts
        const timestamp = new Date().getTime();
        const filename = path.join(tempDir, `FNSKU_Label_${fnsku}_${timestamp}.pdf`);
        
        try {
            // Ensure temp directory exists
            await fs.mkdir(tempDir, { recursive: true });
            
            // Save the PDF
            await fs.writeFile(filename, Buffer.from(doc.output('arraybuffer')));
        } catch (error) {
            throw new LabelGenerationError('Failed to save PDF file', error);
        }

        console.log(`Label generated successfully at: ${filename}`);
        return filename;

    } catch (error) {
        // If it's already our custom error, rethrow it
        if (error instanceof LabelGenerationError) {
            throw error;
        }
        // Otherwise wrap it in our custom error
        throw new LabelGenerationError('Failed to generate label', error);
    }
} 