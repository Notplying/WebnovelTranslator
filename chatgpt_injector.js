// chatgpt_injector.js
(function () {
    console.log("ChatGPT Injector loaded");

    browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.action === 'paste_chunk_v2') {
            console.log("Received paste_chunk_v2 message");
            pasteTextToChatGPT(message.text);
            sendResponse({ success: true });
        }
    });

    function pasteTextToChatGPT(text) {
        // Try to find the textarea
        const textarea = document.querySelector('#prompt-textarea');
        if (textarea) {
            textarea.focus();

            // Clear existing content to prevent duplicates/artifacts
            textarea.textContent = '';

            // For contenteditable div (which ChatGPT is), we should use execCommand 'insertText'
            // This preserves newlines and doesn't interpret HTML tags
            const success = document.execCommand('insertText', false, text);

            if (!success) {
                // Fallback for newer browsers or if execCommand fails
                textarea.textContent = text; // Use textContent instead of innerHTML to avoid parsing HTML

                // Dispatch events to trigger React/framework updates
                textarea.dispatchEvent(new Event('input', { bubbles: true }));
                textarea.dispatchEvent(new Event('change', { bubbles: true }));
            }

            // Adjust height if needed
            textarea.style.height = 'auto';
            textarea.style.height = textarea.scrollHeight + 'px';

            console.log("Text pasted successfully");
        } else {
            console.error("ChatGPT textarea not found");
        }
    }
})();
