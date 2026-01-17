// chatgpt_injector.js
(function () {
    console.log("ChatGPT Injector loaded");

    browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.action === 'paste_chunk_v2') {
            console.log("Received paste_chunk_v2 message");
            pasteTextToChatGPT(message.text).then(success => {
                sendResponse({ success: success });
            });
            return true; // Indicate async response
        }
    });

    async function pasteTextToChatGPT(text) {
        // Try to find the textarea
        const textarea = document.querySelector('#prompt-textarea');
        if (!textarea) {
            console.error("ChatGPT textarea not found");
            return false;
        }

        try {
            textarea.focus();

            // Clear existing content
            textarea.textContent = '';

            // Try 1: execCommand 'insertText' (Standard for contenteditable)
            let success = document.execCommand('insertText', false, text);

            // Try 2: Clipboard API (if requested/available and 'insertText' failed)
            if (!success && navigator.clipboard && navigator.clipboard.writeText) {
                try {
                    await navigator.clipboard.writeText(text);
                    // We still need to paste. Accessing clipboard for 'paste' is hard programmatically.
                    // But maybe the user just wants it in clipboard? 
                    // Assuming 'insertText' is preferred for automation.
                    // If insertText failed, we fallback to textContent manipulation below.
                } catch (e) {
                    console.warn("Clipboard write failed", e);
                }
            }

            if (!success) {
                // Try 3: Fallback DOM manipulation
                textarea.textContent = text;
                textarea.dispatchEvent(new Event('input', { bubbles: true }));
                textarea.dispatchEvent(new Event('change', { bubbles: true }));
                // Check if text is actually there
                if (textarea.textContent === text) success = true;
            }

            // Adjust height
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
