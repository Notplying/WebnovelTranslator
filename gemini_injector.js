// gemini_injector.js
(function () {
    console.log("Gemini Injector loaded");

    browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.action === 'paste_chunk_gemini') {
            console.log("Received paste_chunk_gemini message");
            const success = pasteTextToGemini(message.text);
            sendResponse({ success: success });
        }
    });

    function pasteTextToGemini(text) {
        const selectors = [
            'div[contenteditable="true"]',
            'div[role="textbox"]',
            'textarea'
        ];

        let inputElement = null;
        for (const selector of selectors) {
            inputElement = document.querySelector(selector);
            if (inputElement) break;
        }

        if (inputElement) {
            try {
                inputElement.focus();

                // Safe clear and select
                const selection = window.getSelection();
                const range = document.createRange();
                range.selectNodeContents(inputElement);
                selection.removeAllRanges();
                selection.addRange(range);

                let success = document.execCommand('insertText', false, text);

                if (!success) {
                    // Fallback
                    inputElement.textContent = text;
                    inputElement.dispatchEvent(new Event('input', { bubbles: true }));
                    success = true; // Assume success if fallback didn't throw
                }

                if (inputElement.scrollIntoView) {
                    inputElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }

                console.log("Text pasted successfully to Gemini");
                return success;
            } catch (e) {
                console.error("Error in pasteTextToGemini", e);
                return false;
            }
        } else {
            console.error("Gemini input element not found");
            return false;
        }
    }
})();
