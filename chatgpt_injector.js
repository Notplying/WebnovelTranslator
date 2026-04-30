// chatgpt_injector.js — MV3, polyfill loaded before this script
(function () {
    console.log("ChatGPT Injector loaded (v3)");

    browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.action === 'paste_chunk_v2') {
            console.log("Received paste_chunk_v2 message");
            if (typeof message.text !== 'string') {
                sendResponse({ success: false, error: 'invalid text' });
                return true;
            }
            pasteTextToChatGPT(message.text).then(success => {
                sendResponse({ success: success });
            }).catch(err => {
                console.error('pasteTextToChatGPT error:', err);
                sendResponse({ success: false, error: err.message });
            });
            return true;
        }
    });

    // Remove listener on page unload to prevent memory leaks
    window.addEventListener('unload', () => {
        // Message listeners in content scripts are cleaned up automatically on page unload,
        // but we keep this for explicitness and compatibility.
    });

    async function pasteTextToChatGPT(text) {
        const textarea = document.querySelector('#prompt-textarea');
        if (!textarea) {
            console.error("ChatGPT textarea not found");
            return false;
        }

        try {
            textarea.focus();

            let success = document.execCommand('insertText', false, text);

            if (!success) {
                // DOM insertion fallback: directly set value and fire synthetic events.
                textarea.value = text;
                textarea.dispatchEvent(new Event('input', { bubbles: true }));
                textarea.dispatchEvent(new Event('change', { bubbles: true }));
                if (textarea.value === text) success = true;
            }

            // Reset min-height and adjust height for auto-growing textarea
            textarea.style.minHeight = '0';
            textarea.style.height = 'auto';
            textarea.style.height = textarea.scrollHeight + 'px';

            console.log(success ? "Text pasted successfully" : "Text paste failed");
            return success;
        } catch (error) {
            console.error("Error pasting text:", error);
            return false;
        }
    }
})();
