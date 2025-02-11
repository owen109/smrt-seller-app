# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react/README.md) uses [Babel](https://babeljs.io/) for Fast Refresh
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react-swc) uses [SWC](https://swc.rs/) for Fast Refresh

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type aware lint rules:

- Configure the top-level `parserOptions` property like this:

```js
export default tseslint.config({
  languageOptions: {
    // other options...
    parserOptions: {
      project: ['./tsconfig.node.json', './tsconfig.app.json'],
      tsconfigRootDir: import.meta.dirname,
    },
  },
})
```

- Replace `tseslint.configs.recommended` to `tseslint.configs.recommendedTypeChecked` or `tseslint.configs.strictTypeChecked`
- Optionally add `...tseslint.configs.stylisticTypeChecked`
- Install [eslint-plugin-react](https://github.com/jsx-eslint/eslint-plugin-react) and update the config:

```js
// eslint.config.js
import react from 'eslint-plugin-react'

export default tseslint.config({
  // Set the react version
  settings: { react: { version: '18.3' } },
  plugins: {
    // Add the react plugin
    react,
  },
  rules: {
    // other rules...
    // Enable its recommended rules
    ...react.configs.recommended.rules,
    ...react.configs['jsx-runtime'].rules,
  },
})
```

# SMRT Seller App

A powerful automation tool for Amazon Seller Central, built with Electron and React.

## Build and Notarization Guide for macOS

### Prerequisites

1. Apple Developer Account with Developer ID Application certificate
2. Environment variables set in `.env`:
   ```
   APPLE_ID=your.email@example.com
   APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx
   APPLE_TEAM_ID=YOUR_TEAM_ID
   ```

### Build Process

1. **Install Dependencies**
   ```bash
   npm install
   ```

2. **Build the Application**
   ```bash
   # This will build and sign the app
   npm run dist:mac
   ```

### Manual Notarization Process

If the automatic notarization fails or you need to notarize separately:

1. **Build and Sign Only**
   ```bash
   # First, build and sign the app
   npm run transpile:electron && npm run build && electron-builder --mac --arm64 --config.afterSign=null
   ```

2. **Sign the App**
   ```bash
   # Sign the app with your Developer ID
   npm run sign:mac
   ```

3. **Create ZIP for Notarization**
   ```bash
   # Create a ZIP of the app for notarization
   ditto -c -k --keepParent "dist/mac-arm64/SMRT Seller.app" "dist/mac-arm64/SMRT Seller.zip"
   ```

4. **Submit for Notarization**
   ```bash
   # Submit the app for notarization
   npm run notarize:mac
   ```

   check the status of the notarization with:
   ```bash
   xcrun notarytool history --apple-id "$APPLE_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD" --team-id "$APPLE_TEAM_ID"
   ```
  
5. **Staple the Ticket**
   ```bash
   # After successful notarization, staple the ticket
   xcrun stapler staple "dist/mac-arm64/SMRT Seller.app"
   ```

### Troubleshooting

- If notarization fails, check the Apple Developer portal for detailed error messages
- Ensure all required entitlements are properly set in `build/entitlements.mac.plist`
- Verify your Developer ID certificate is valid and trusted
- Check that all environment variables are properly set in `.env`

### Important Files

- `electron-builder.json`: Build configuration
- `build/entitlements.mac.plist`: macOS entitlements
- `notarize.cjs`: Notarization script
- `.env`: Environment variables

### Notes

- The build process may take 5-15 minutes
- Notarization can take 5-30 minutes depending on Apple's service
- Keep your Apple ID credentials and app-specific password secure
- The app must be signed with a valid Developer ID Application certificate
- All third-party dependencies must be properly signed and notarized

# Build and sign
npm run transpile:electron && npm run build && electron-builder --mac --arm64 --config.afterSign=null

# Sign
npm run sign:mac

# Create ZIP and notarize
ditto -c -k --keepParent "dist/mac-arm64/SMRT Seller.app" "dist/mac-arm64/SMRT Seller.zip"
npm run notarize:mac

# Staple (after notarization completes)
xcrun stapler staple "dist/mac-arm64/SMRT Seller.app"