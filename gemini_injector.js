// gemini_injector.js — MV3, polyfill loaded before this script
(function () {
    console.log("Gemini Injector loaded (v3)");

    const messageHandler = (message, sender, sendResponse) => {
        if (message.action === 'paste_chunk_gemini') {
            console.log("Received paste_chunk_gemini message");
            if (typeof message.text !== 'string') {
                sendResponse({ success: false, error: 'invalid text' });
                return true;
            }
            const success = pasteTextToGemini(message.text);
            sendResponse({ success: success });
            return true;
        }
    };
    browser.runtime.onMessage.addListener(messageHandler);

    // Remove listener on page unload to prevent memory leaks
    window.addEventListener('unload', () => {
        browser.runtime.onMessage.removeListener(messageHandler);
    });

    function pasteTextToGemini(text) {
        const selectors = [
            'div[contenteditable="true"]',
            'div[role="textbox"]',
            'textarea'
        ];

        let inputElement = null;
        for (const selector of selectors) {
            const el = document.querySelector(selector);
            if (el) {
                const style = getComputedStyle(el);
                const isVisible = style.visibility !== 'hidden' && style.display !== 'none';
                const isFixed = style.position === 'fixed';
                // offsetParent is null for fixed elements and hidden elements — also check computed style
                if ((el.offsetParent !== null || isFixed) && isVisible) {
                    inputElement = el;
                    break;
                }
            }
        }

        if (inputElement) {
            try {
                // Save current page selection before manipulating ranges
                const selection = window.getSelection();
                const savedRanges = [];
                for (let i = 0; i < selection.rangeCount; i++) {
                    savedRanges.push(selection.getRangeAt(i).cloneRange());
                }

                inputElement.focus();

                const range = document.createRange();
                range.selectNodeContents(inputElement);
                selection.removeAllRanges();
                selection.addRange(range);

                let success = document.execCommand('insertText', false, text);

                // Restore page selection after paste
                selection.removeAllRanges();
                savedRanges.forEach(r => selection.addRange(r));

                if (!success) {
                    const isReadOnly = inputElement.disabled || inputElement.readOnly;
                    if (isReadOnly) {
                        console.error("Input element is disabled or read-only");
                        return false;
                    }

                    if (inputElement instanceof HTMLTextAreaElement) {
                        inputElement.value = text;
                        if (inputElement.value === text) {
                            inputElement.dispatchEvent(new Event('input', { bubbles: true }));
                            inputElement.dispatchEvent(new Event('change', { bubbles: true }));
                            success = true;
                        }
                    } else if (inputElement instanceof HTMLInputElement) {
                        inputElement.value = text;
                        if (inputElement.value === text) {
                            inputElement.dispatchEvent(new Event('input', { bubbles: true }));
                            inputElement.dispatchEvent(new Event('change', { bubbles: true }));
                            success = true;
                        }
                    } else {
                        // contenteditable
                        inputElement.textContent = text;
                        if (inputElement.textContent === text) {
                            inputElement.dispatchEvent(new Event('input', { bubbles: true }));
                            success = true;
                        }
                    }
                }

                if (inputElement.scrollIntoView) {
                    try {
                        inputElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    } catch (e) {
                        console.warn('scrollIntoView failed:', e);
                    }
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
