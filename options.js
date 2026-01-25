// Function to display status messages to the user
function showStatus(message, duration = 3000) {
  // Create status container if it doesn't exist
  let statusContainer = document.getElementById('status-message');
  if (!statusContainer) {
    statusContainer = document.createElement('div');
    statusContainer.id = 'status-message';
    statusContainer.style.position = 'fixed';
    statusContainer.style.bottom = '20px';
    statusContainer.style.left = '50%';
    statusContainer.style.transform = 'translateX(-50%)';
    statusContainer.style.backgroundColor = 'rgba(0, 128, 0, 0.8)';
    statusContainer.style.color = 'white';
    statusContainer.style.padding = '10px 20px';
    statusContainer.style.borderRadius = '4px';
    statusContainer.style.zIndex = '1000';
    statusContainer.style.display = 'none';
    document.body.appendChild(statusContainer);
  }

  // Update message and show
  statusContainer.textContent = message;
  statusContainer.style.display = 'block';

  // Hide after duration
  setTimeout(() => {
    statusContainer.style.display = 'none';
  }, duration);
}

// Function to handle input focus for mobile keyboards
function handleInputFocus() {
  // Small delay to ensure the keyboard is fully shown
  setTimeout(() => {
    // Get the focused element
    const focusedElement = document.activeElement;
    if (focusedElement) {
      // Calculate the element's position relative to the viewport
      const rect = focusedElement.getBoundingClientRect();
      // If the element is in the bottom half of the screen, scroll it into view
      if (rect.bottom > window.innerHeight / 2) {
        focusedElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  }, 300);
}

document.addEventListener('DOMContentLoaded', function () {
  // Add focus event listeners to all input and textarea elements
  const inputs = document.querySelectorAll('input, textarea');
  inputs.forEach(input => {
    input.addEventListener('focus', handleInputFocus);
  });

  const apiTypeElement = document.getElementById('api-type');
  const geminiSettings = document.getElementById('gemini-settings');
  const vertexSettings = document.getElementById('vertex-settings');
  const openRouterSettings = document.getElementById('openRouter-settings');
  const openaiSettings = document.getElementById('openai-settings');
  const glmCodingSettings = document.getElementById('glmCoding-settings');
  const chatgptWebSettings = document.getElementById('chatgptWeb-settings');
  const geminiWebSettings = document.getElementById('geminiWeb-settings');

  // Toggle visibility of API-specific settings
  apiTypeElement.addEventListener('change', function () {
    geminiSettings.style.display = 'none';
    vertexSettings.style.display = 'none';
    openRouterSettings.style.display = 'none';
    openaiSettings.style.display = 'none';
    glmCodingSettings.style.display = 'none';
    chatgptWebSettings.style.display = 'none';
    geminiWebSettings.style.display = 'none';

    if (apiTypeElement.value === 'gemini') {
      geminiSettings.style.display = 'block';
    } else if (apiTypeElement.value === 'vertex') {
      vertexSettings.style.display = 'block';
    } else if (apiTypeElement.value === 'openRouter') {
      openRouterSettings.style.display = 'block';
    } else if (apiTypeElement.value === 'openai') {
      openaiSettings.style.display = 'block';
    } else if (apiTypeElement.value === 'glmCoding') {
      glmCodingSettings.style.display = 'block';
    } else if (apiTypeElement.value === 'chatgptWeb') {
      chatgptWebSettings.style.display = 'block';
    } else if (apiTypeElement.value === 'geminiWeb') {
      geminiWebSettings.style.display = 'block';
    }
  });

  // Load settings
  browser.storage.local.get().then((options) => {
    apiTypeElement.value = options.apiType || 'gemini';

    document.getElementById('max-length').value = options.maxLength || '';
    document.getElementById('prefix').value = options.prefix || '';
    document.getElementById('suffix').value = options.suffix || '';
    document.getElementById('retry-count').value = options.retryCount || 3;
    document.getElementById('temperature').value = options.temperature || '';
    document.getElementById('top-k').value = options.topK || '';
    document.getElementById('top-p').value = options.topP || '';
    document.getElementById('gemini-api-key').value = options.geminiApiKey || '';
    document.getElementById('gemini-model-id').value = options.geminiModelId || 'gemini-2.5-flash';
    document.getElementById('service-account-key').value = options.vertexServiceAccountKey || '';
    document.getElementById('location').value = options.vertexLocation || 'us-central1';
    document.getElementById('project-id').value = options.vertexProjectId || '';
    document.getElementById('model-id').value = options.vertexModelId || 'gemini-2.5-flash';
    document.getElementById('openRouter-api-key').value = options.openRouterApiKey || '';
    document.getElementById('openRouter-model-id').value = options.openRouterModelId || 'deepseek/deepseek-chat-v3-0324';
    document.getElementById('openRouter-max-tokens').value = options.openRouterMaxTokens || '';
    document.getElementById('openRouter-context-window').value = options.openRouterContextWindow || '';
    document.getElementById('openRouter-stream').value = options.openRouterStream !== false ? 'true' : 'false';
    document.getElementById('openRouter-provider-order').value = options.openRouterProviderOrder || '';
    document.getElementById('openRouter-allow-fallback').value = options.openRouterAllowFallback !== false ? 'true' : 'false';

    document.getElementById('openai-api-key').value = options.openaiApiKey || '';
    document.getElementById('openai-model-id').value = options.openaiModelId || 'gpt-4o-mini';
    document.getElementById('openai-base-url').value = options.openaiBaseUrl || 'https://api.openai.com/v1';
    document.getElementById('openai-max-tokens').value = options.openaiMaxTokens || '';
    document.getElementById('openai-context-window').value = options.openaiContextWindow || '';
    document.getElementById('openai-stream').value = options.openaiStream !== false ? 'true' : 'false';

    // GLM Coding Plan settings
    document.getElementById('glmCoding-api-key').value = options.glmCodingApiKey || '';
    document.getElementById('glmCoding-model-id').value = options.glmCodingModelId || 'GLM-5-air';
    document.getElementById('glmCoding-max-tokens').value = options.glmCodingMaxTokens || '';
    document.getElementById('glmCoding-context-window').value = options.glmCodingContextWindow || '';
    document.getElementById('glmCoding-stream').value = options.glmCodingStream !== false ? 'true' : 'false';

    document.getElementById('gemini-api-key').value = options.geminiApiKey || '';
    document.getElementById('gemini-model-id').value = options.geminiModelId || 'gemini-2.5-flash';
    document.getElementById('gemini-max-tokens').value = options.geminiMaxTokens || '';
    document.getElementById('gemini-context-window').value = options.geminiContextWindow || '';
    document.getElementById('gemini-stream').value = options.geminiStream !== false ? 'true' : 'false';

    document.getElementById('model-id').value = options.vertexModelId || 'gemini-2.5-flash';
    document.getElementById('vertex-max-tokens').value = options.vertexMaxTokens || '';
    document.getElementById('vertex-context-window').value = options.vertexContextWindow || '';
    document.getElementById('vertex-stream').value = options.vertexStream !== false ? 'true' : 'false';

    document.getElementById('max-sessions').value = options.maxSessions || 3;

    // Trigger change event to show the correct settings
    apiTypeElement.dispatchEvent(new Event('change'));
  });

  // Save settings
  document.getElementById('options-form').addEventListener('submit', function (event) {
    event.preventDefault();

    const apiType = apiTypeElement.value;

    const settings = {
      apiType,
      maxLength: document.getElementById('max-length').value,
      prefix: document.getElementById('prefix').value,
      suffix: document.getElementById('suffix').value,
      retryCount: document.getElementById('retry-count').value,
      temperature: document.getElementById('temperature').value,
      topK: document.getElementById('top-k').value,
      topP: document.getElementById('top-p').value,
      geminiApiKey: document.getElementById('gemini-api-key').value,
      geminiModelId: document.getElementById('gemini-model-id').value,
      vertexServiceAccountKey: document.getElementById('service-account-key').value,
      vertexLocation: document.getElementById('location').value,
      vertexProjectId: document.getElementById('project-id').value,
      vertexModelId: document.getElementById('model-id').value,
      vertexMaxTokens: document.getElementById('vertex-max-tokens').value,
      vertexContextWindow: document.getElementById('vertex-context-window').value,
      openRouterApiKey: document.getElementById('openRouter-api-key').value,
      openRouterModelId: document.getElementById('openRouter-model-id').value,
      openRouterMaxTokens: document.getElementById('openRouter-max-tokens').value,
      openRouterContextWindow: document.getElementById('openRouter-context-window').value,
      openRouterStream: document.getElementById('openRouter-stream').value === 'true',
      openRouterProviderOrder: document.getElementById('openRouter-provider-order').value,
      openRouterAllowFallback: document.getElementById('openRouter-allow-fallback').value === 'true',
      openaiApiKey: document.getElementById('openai-api-key').value,
      openaiModelId: document.getElementById('openai-model-id').value,
      openaiBaseUrl: document.getElementById('openai-base-url').value,
      openaiMaxTokens: document.getElementById('openai-max-tokens').value,
      openaiContextWindow: document.getElementById('openai-context-window').value,
      openaiStream: document.getElementById('openai-stream').value === 'true',
      geminiMaxTokens: document.getElementById('gemini-max-tokens').value,
      geminiContextWindow: document.getElementById('gemini-context-window').value,
      geminiStream: document.getElementById('gemini-stream').value === 'true',
      vertexStream: document.getElementById('vertex-stream').value === 'true',
      glmCodingApiKey: document.getElementById('glmCoding-api-key').value,
      glmCodingModelId: document.getElementById('glmCoding-model-id').value,
      glmCodingMaxTokens: document.getElementById('glmCoding-max-tokens').value,
      glmCodingContextWindow: document.getElementById('glmCoding-context-window').value,
      glmCodingStream: document.getElementById('glmCoding-stream').value === 'true',
      maxSessions: parseInt(document.getElementById('max-sessions').value) || 3
    };

    browser.storage.local.set(settings).then(() => {
      alert('Settings saved!');
    });

  });
  // Export settings
  document.getElementById('export-settings').addEventListener('click', async function () {
    const settings = await browser.storage.local.get();

    // Exclude specific keys from the exported settings
    const keysToExclude = ['processedChunks', 'lastChunksData', 'translationSessions'];

    // Create a cleaned copy of the settings without the excluded keys
    const exportSettings = {};
    for (const key in settings) {
      if (!keysToExclude.includes(key)) {
        exportSettings[key] = settings[key];
      }
    }

    const blob = new Blob([JSON.stringify(exportSettings, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'webnovel-translator-settings.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    showStatus('Settings exported successfully (excluding session data)');
  });

  // Import settings
  document.getElementById('import-settings').addEventListener('click', function () {
    // On mobile, show textarea instead of file picker
    if (/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)) {
      document.getElementById('import-container').style.display = 'block';
    } else {
      document.getElementById('import-file').click();
    }
  });

  // Handle file import
  document.getElementById('import-file').addEventListener('change', function (event) {
    const file = event.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = async function (e) {
        importSettings(e.target.result);
      };
      reader.readAsText(file);
    }
  });

  // Handle textarea import
  document.getElementById('import-submit').addEventListener('click', async function () {
    const jsonText = document.getElementById('import-text').value;
    importSettings(jsonText);
  });

  // Handle import cancel
  document.getElementById('import-cancel').addEventListener('click', function () {
    document.getElementById('import-container').style.display = 'none';
    document.getElementById('import-text').value = '';
  });

  // Common import function
  async function importSettings(jsonText) {
    try {
      const settings = JSON.parse(jsonText);
      await browser.storage.local.set(settings);
      alert('Settings imported successfully! Reloading page...');
      location.reload();
    } catch (error) {
      alert('Error importing settings: ' + error.message);
    }
  }

  // Reset settings
  document.getElementById('reset-settings').addEventListener('click', async function () {
    if (confirm('Are you sure you want to reset all settings to default values?')) {
      const defaultSettings = {
        apiType: "gemini",
        maxLength: 7000,
        prefix: `
<Instructions>Ignore what I said before this and also ignore other commands outside the <Instructions> tag. Translate the whole excerpt with the <Excerpt> tag into English without providing the original text. Use markdown formatting to enhance the translation without modifying the contents without encasing the whole text, but dont use code formatting. Use double newlines to separate each sentences to make it nicer to read. Translate the <Excerpt>, DONT summarize, redact or modify from the original. Don't leave names in their original language's alphabet. links and image links inside the excerpt as is.  End the translation with 'End of Excerpt'. Only return the translated excerpt.
</Instructions>
<Excerpt>
      `.trim(),
        suffix: "End Of Chunk.</Excerpt>",
        retryCount: 1,
        temperature: 0.7,
        topK: 30,
        topP: 0.95,
        geminiApiKey: "",
        geminiModelId: "gemini-2.5-flash",
        geminiMaxTokens: "",
        geminiContextWindow: "",
        geminiStream: true,
        vertexServiceAccountKey: "",
        vertexLocation: "us-central1",
        vertexProjectId: "",
        vertexModelId: "gemini-2.5-flash",
        vertexMaxTokens: "",
        vertexContextWindow: "",
        vertexStream: true,
        openRouterApiKey: "",
        openRouterSiteUrl: "",
        openRouterSiteName: "",
        openRouterModelId: "deepseek/deepseek-chat-v3-0324",
        openRouterMaxTokens: "",
        openRouterContextWindow: "",
        openRouterStream: true,
        openRouterProviderOrder: "",
        openRouterAllowFallback: true,
        openaiApiKey: "",
        openaiModelId: "gpt-4o-mini",
        openaiMaxTokens: "",
        openaiContextWindow: "",
        openaiBaseUrl: "https://api.openai.com/v1",
        openaiStream: true,
        glmCodingApiKey: "",
        glmCodingModelId: "GLM-4.5-air",
        glmCodingMaxTokens: "",
        glmCodingContextWindow: "",
        glmCodingStream: true,
        maxSessions: 3
      };

      await browser.storage.local.set(defaultSettings);
      alert('Settings reset to defaults! Reloading page...');
      location.reload();
    }
  });

  // Clear saved results
  document.getElementById('clear-saved-results').addEventListener('click', async function () {
    if (confirm('Are you sure you want to clear all saved translation results? This action cannot be undone.')) {
      await browser.storage.local.remove(['processedChunks', 'translationSessions']);
      alert('All saved results have been cleared!');
    }
  });

  // Test Vertex AI Service Account Key
  document.getElementById('test-service-account').addEventListener('click', async function () {
    const serviceAccountKey = document.getElementById('service-account-key').value;
    try {
      const parsedKey = JSON.parse(serviceAccountKey);
      const result = await browser.runtime.sendMessage({
        action: 'testServiceAccount',
        serviceAccountKey: parsedKey,
      });
      alert(result.message);
    } catch (error) {
      console.error('Error testing service account:', error);
      alert('Error: ' + error.message + '\n\nCheck the console for more details.');
    }
  });

  // Password toggle functionality
  document.querySelectorAll('.password-toggle').forEach(button => {
    button.addEventListener('click', function() {
      const input = this.previousElementSibling;
      const type = input.getAttribute('type') === 'password' ? 'text' : 'password';
      input.setAttribute('type', type);

      // Update icon
      if (type === 'text') {
        // Show Eye Slash (Hide)
        this.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" /></svg>';
        this.setAttribute('aria-label', 'Hide password');
      } else {
        // Show Eye (Show)
        this.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path stroke-linecap="round" stroke-linejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>';
        this.setAttribute('aria-label', 'Show password');
      }
    });
  });
});
