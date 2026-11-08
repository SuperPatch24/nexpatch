// NexpatchOnline site configuration.
// These values identify your app registration and backend. They are public by design, not secrets.
// Never put a client secret, certificate or password in this file.
window.NEXPATCH_CONFIG = {
  // Application (client) ID of your multi-tenant app registration in Microsoft Entra ID.
  // Leave empty to run the site with sample data only.
  clientId: '',

  // 'organizations' lets anyone with a work or school account sign in.
  authority: 'https://login.microsoftonline.com/organizations',

  // Register this exact address under "Single-page application" in Entra ID.
  redirectUri: window.location.origin + '/',

  // Register this exact address under "Web" in Entra ID. Used when an admin approves NexpatchOnline.
  consentRedirectUri: window.location.origin + '/consent',

  // Backend API address, ending in /api. Leave empty until the backend is deployed.
  // Example: 'https://nexpatch-api.azurewebsites.net/api'
  apiBaseUrl: '',

  // Optional. Defaults to api://<clientId>/access_as_user (the scope from "Expose an API").
  apiScope: ''
};
