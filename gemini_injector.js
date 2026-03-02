// gemini_injector.js — MV3, polyfill loaded before this script
(function () {
    console.log("Gemini Injector loaded (v3)");

    browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.action === 'paste_chunk_gemini') {
            console.log("Received paste_chunk_gemini message");
            const success = pasteTextToGemini(message.text);
            sendResponse({ success: success });
            return true;
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

                const selection = window.getSelection();
                const range = document.createRange();
                range.selectNodeContents(inputElement);
                selection.removeAllRanges();
                selection.addRange(range);

                let success = document.execCommand('insertText', false, text);

                if (!success) {
                    if (inputElement.disabled || (inputElement.readOnly && (inputElement instanceof HTMLInputElement || inputElement instanceof HTMLTextAreaElement))) {
                        console.error("Input element is disabled or read-only");
                        return false;
                    }

                    if (inputElement instanceof HTMLInputElement || inputElement instanceof HTMLTextAreaElement) {
                        inputElement.value = text;
                        if (inputElement.value === text) {
                            inputElement.dispatchEvent(new Event('input', { bubbles: true }));
                            inputElement.dispatchEvent(new Event('change', { bubbles: true }));
                            success = true;
                        }
                    } else {
                        inputElement.textContent = text;
                        if (inputElement.textContent === text) {
                            inputElement.dispatchEvent(new Event('input', { bubbles: true }));
                            success = true;
                        }
                    }
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
