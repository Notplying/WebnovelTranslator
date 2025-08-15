function splitParagraphText(lengthinput) {
  let maxLength = lengthinput;
  console.log('maxLength in splitParagraphText:', maxLength);
  let paragraphId = 1;
  let combinedContent = "";

  let textLeftDiv = document.querySelector('.text-left');
  let novel_contentDiv = document.querySelector('#novel_content');
  
  function extractContentWithImages(element) {
    let content = "";
    element.childNodes.forEach(node => {
      if (node.nodeType === Node.ELEMENT_NODE) {
        if (node.tagName.toLowerCase() === 'img') {
          // Preserve img tags completely
          content += node.outerHTML + '\n\n';
        } else if (node.tagName.toLowerCase() === 'p') {
          // For p tags, include both text and any img tags inside
          content += node.innerHTML + '\n\n';
        } else {
          // For other elements, recursively process
          content += extractContentWithImages(node);
        }
      } else if (node.nodeType === Node.TEXT_NODE && node.textContent.trim() !== '') {
        content += node.textContent.trim() + '\n\n';
      }
    });
    return content;
  }

  if (textLeftDiv) {
      let children = textLeftDiv.childNodes;
      
      children.forEach(node => {
          if (node.nodeType === Node.ELEMENT_NODE && node.tagName.toLowerCase() === 'p') {
              combinedContent += node.innerHTML + '\n\n';
          } else if (node.nodeType === Node.TEXT_NODE && node.textContent.trim() !== '') {
              let lines = node.textContent.trim().split(']');
              lines.forEach(line => {
                  if (line.trim() !== '') {
                      combinedContent += line.trim() + ']\n\n';
                  }
              });
          } else if (node.nodeType === Node.ELEMENT_NODE && node.tagName.toLowerCase() === 'img') {
              combinedContent += node.outerHTML + '\n\n';
          }
      });
       
  } else if (novel_contentDiv) { //booktoki
    let innerDivs = novel_contentDiv.querySelectorAll('div');
    
    innerDivs.forEach(div => {
      combinedContent += extractContentWithImages(div);
    });
  } else {
      while (true) {
          let paragraphElement = document.getElementById(`p${paragraphId}`);
          if (!paragraphElement) {
              paragraphElement = document.getElementById(`L${paragraphId}`);
          }
          if (!paragraphElement) break;

          combinedContent += paragraphElement.innerHTML + '\n\n';
          paragraphId++;
      }
  }

  const textChunks = splitTextIntoChunks(combinedContent, maxLength);
  return textChunks;
}

function splitTextIntoChunks(text, maxLength) {
  const chunks = [];
  let startIndex = 0;

  while (startIndex < text.length) {
    let endIndex = startIndex + maxLength;
    if (endIndex < text.length) {
      endIndex = text.lastIndexOf('\n', endIndex);
      if (endIndex === -1) {
        endIndex = startIndex + maxLength;
      }
    }
    const chunk = text.substring(startIndex, endIndex);
    console.log(`Chunk length: ${chunk.length}`);
    chunks.push(chunk);
    startIndex = endIndex + 1;
  }

  return chunks;
}

function openChunksPage(chunks, prefix, suffix, retryCount) {
  // Send all necessary data to the background script
  browser.runtime.sendMessage({
    action: 'openChunksPage',
    chunks: chunks,
    prefix: prefix,
    suffix: suffix,
    retryCount: retryCount
  });
}

async function processChunkWithGemini(chunk, prefix, suffix, retries, delay) {
  for (let attempt = 0; attempt < retries; attempt++) {
    // Update attempt progress before processing
    browser.runtime.sendMessage({
      action: 'updateChunksPage',
      data: {action: 'updateAttemptProgress', current: attempt + 1, total: retries}
    });

    try {
      console.log(`Attempt ${attempt + 1} - Sending message to background script`);
      
      const response = await browser.runtime.sendMessage({
        action: 'processChunk',
        chunk,
        prefix,
        suffix
      });
      
      console.log('Received response from background script:', response);
      
      if (response.error) {
        throw new Error(response.error);
      }
      
      return { success: true, result: response.result };
    } catch (error) {
      console.error(`Attempt ${attempt + 1} - Error in processChunkWithGemini:`, error);
      
      if (error.message.includes("PERMISSION_DENIED") && error.message.includes("Please use API Key")) {
        // API key error, show message to user
        browser.runtime.sendMessage({
          action: 'updateChunksPage',
          data: {
            action: 'showError',
            errorContent: `
              <h2>API Key Error</h2>
              <p>It seems that the API key is missing or invalid. Please follow these steps:</p>
              <ol>
                <li>Go to the extension settings</li>
                <li>Enter a valid API key for the Gemini API</li>
                <li>Save the settings</li>
                <li>Try running the extension again</li>
              </ol>
              <p>If you don't have an API key, you can obtain one from the Google AI Studio.</p>
            `
          }
        });
        return { success: false, error: 'Invalid API Key', fatal: true };
      }
      
      if (error.message.includes("NetworkError") || error.message.includes("503") || 
          error.message.includes("UNAVAILABLE") || error.message.includes("Could not establish connection")) {
        if (attempt < retries - 1) {
          console.log(`Retrying in ${delay / 1000} seconds...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        } else {
          return { success: false, error: `Error processing chunk with Gemini API after ${retries} attempts: ${error.message}` };
        }
      } else {
        // For other types of errors, don't retry
        return { success: false, error: `Error processing chunk with Gemini API: ${error.message}`, fatal: true };
      }
    }
  }
}

browser.storage.local.get(['maxLength', 'prefix', 'suffix', 'retryCount']).then(async ({ maxLength, prefix, suffix, retryCount }) => {
  const textChunks = await splitParagraphText(Number(maxLength) || 4000);
  openChunksPage(textChunks, prefix, suffix, Number(retryCount) || 3);
});