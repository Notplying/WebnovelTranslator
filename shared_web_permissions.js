// Shared web permissions configuration for optional host permissions.
// Used by both service_worker.js and options.js to avoid duplication.
const WEB_PERMISSIONS = {
    chatgptWeb: { origins: ['https://chatgpt.com/*', 'https://chat.openai.com/*'], permissions: ['tabs'] },
    geminiWeb: { origins: ['https://gemini.google.com/*'], permissions: ['tabs'] }
};