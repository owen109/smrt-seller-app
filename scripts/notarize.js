import { notarize } from '@electron/notarize';
import path from 'path';
import fs from 'fs';

async function notarizeApp() {
    console.log('\n=== Starting Manual Notarization Process ===');
    
    const appPath = path.resolve('./dist/mac-arm64/SMRT Seller.app');
    const appBundleId = 'com.specs.smrt-seller-app';
    
    console.log('Notarization environment:', {
        hasAppleId: !!process.env.APPLE_ID,
        hasPassword: !!process.env.APPLE_APP_SPECIFIC_PASSWORD,
        hasTeamId: !!process.env.APPLE_TEAM_ID,
        appPath,
        appBundleId,
        exists: fs.existsSync(appPath)
    });

    if (!process.env.APPLE_ID) {
        throw new Error('APPLE_ID environment variable is required for notarization');
    }

    if (!process.env.APPLE_APP_SPECIFIC_PASSWORD) {
        throw new Error('APPLE_APP_SPECIFIC_PASSWORD environment variable is required for notarization');
    }

    if (!fs.existsSync(appPath)) {
        throw new Error(`App not found at path: ${appPath}`);
    }

    try {
        console.log(`\nUploading ${appPath} to Apple's notarization service...`);
        console.log('This may take several minutes...');
        console.log('Team ID:', process.env.APPLE_TEAM_ID || 'GQN9G64546');
        
        await notarize({
            tool: 'notarytool',
            appPath,
            appBundleId,
            teamId: process.env.APPLE_TEAM_ID || 'GQN9G64546',
            appleId: process.env.APPLE_ID,
            appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
        });
        
        console.log('\n=== Notarization Complete! ===');
        console.log('Your application has been successfully notarized by Apple.');
    } catch (error) {
        console.error('\n=== Notarization Failed ===');
        console.error('Error details:', error);
        process.exit(1);
    }
}

notarizeApp().catch(err => {
    console.error('Notarization error:', err);
    process.exit(1);
}); 