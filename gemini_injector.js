// gemini_injector.js
(function () {
    console.log("Gemini Injector loaded");

    browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.action === 'paste_chunk_gemini') {
            console.log("Received paste_chunk_gemini message");
            pasteTextToGemini(message.text);
            sendResponse({ success: true });
        }
    });

    function pasteTextToGemini(text) {
        // Try to find the input element. 
        // Gemini typically uses a contenteditable div within a rich-textarea.
        // It often has a role="textbox" and contenteditable="true"

        const selectors = [
            'div[contenteditable="true"]',
            'div[role="textbox"]',
            'textarea' // Fallback
        ];

        let inputElement = null;
        for (const selector of selectors) {
            inputElement = document.querySelector(selector);
            if (inputElement) {
                // Ensure it's not a search bar but the main input. 
                // Usually the main input is larger or in a specific container, but basic selector often hits it first on the chat page.
                break;
            }
        }

        if (inputElement) {
            inputElement.focus();

            // Clear existing content to avoid duplicates (safest way is select all + insert)
            // Or just setting textContent if empty. 
            // Let's try select all -> insertText to mock user behavior best.
            document.execCommand('selectAll', false, null);
            const success = document.execCommand('insertText', false, text);

            if (!success) {
                // Fallback
                inputElement.textContent = text;
                inputElement.dispatchEvent(new Event('input', { bubbles: true }));
            }

            // Optional: try to adjust height or scroll
            inputElement.scrollIntoView({ behavior: 'smooth', block: 'center' });

            console.log("Text pasted successfully to Gemini");
        } else {
            console.error("Gemini input element not found");
        }
    }
})();
