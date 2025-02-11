const { notarize } = require('@electron/notarize');
const path = require('path');
require('dotenv').config();

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;  
  if (electronPlatformName !== 'darwin') {
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);

  // Log environment variables (without sensitive data)
  console.log('\n=== Starting Notarization Process ===');
  console.log('Notarization environment:', {
    hasAppleId: !!process.env.APPLE_ID,
    hasPassword: !!process.env.APPLE_APP_SPECIFIC_PASSWORD,
    hasTeamId: !!process.env.APPLE_TEAM_ID,
    appPath
  });

  if (!process.env.APPLE_ID) {
    throw new Error('APPLE_ID environment variable is required for notarization');
  }

  if (!process.env.APPLE_APP_SPECIFIC_PASSWORD) {
    throw new Error('APPLE_APP_SPECIFIC_PASSWORD environment variable is required for notarization');
  }

  try {
    console.log(`\nUploading ${appPath} to Apple's notarization service...`);
    console.log('This may take several minutes...');
    console.log('Team ID:', process.env.APPLE_TEAM_ID || 'GQN9G64546');
    
    await notarize({
      tool: 'notarytool',
      appPath,
      teamId: process.env.APPLE_TEAM_ID || 'GQN9G64546',
      appleId: process.env.APPLE_ID,
      appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
      debug: true
    });
    
    console.log('\n=== Notarization Complete! ===');
    console.log('Your application has been successfully notarized by Apple.');
  } catch (error) {
    console.error('\n=== Notarization Failed ===');
    console.error('Error details:', error);
    throw error;
  }
}; 