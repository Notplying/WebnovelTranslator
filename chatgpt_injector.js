// chatgpt_injector.js — MV3, polyfill loaded before this script
(function () {
    console.log("ChatGPT Injector loaded (v3)");

    browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.action === 'paste_chunk_v2') {
            console.log("Received paste_chunk_v2 message");
            pasteTextToChatGPT(message.text).then(success => {
                sendResponse({ success: success });
            });
            return true;
        }
    });

    async function pasteTextToChatGPT(text) {
        const textarea = document.querySelector('#prompt-textarea');
        if (!textarea) {
            console.error("ChatGPT textarea not found");
            return false;
        }

        try {
            textarea.focus();
            textarea.textContent = '';

            let success = document.execCommand('insertText', false, text);

            if (!success && navigator.clipboard && navigator.clipboard.writeText) {
                try {
                    await navigator.clipboard.writeText(text);
                } catch (e) {
                    console.warn("Clipboard write failed", e);
                }
            }

            if (!success) {
                textarea.textContent = text;
                textarea.dispatchEvent(new Event('input', { bubbles: true }));
                textarea.dispatchEvent(new Event('change', { bubbles: true }));
                if (textarea.textContent === text) success = true;
            }

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
