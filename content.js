// content.js — MV3 cross-browser via browser-polyfill
// The `browser` global is available via the polyfill loaded before this script.

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
          content += node.outerHTML + '\n\n';
        } else if (node.tagName.toLowerCase() === 'p') {
          content += node.innerHTML + '\n\n';
        } else {
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
  } else if (novel_contentDiv) {
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
  browser.runtime.sendMessage({
    action: 'openChunksPage',
    chunks: chunks,
    prefix: prefix,
    suffix: suffix,
    retryCount: retryCount
  });
}

browser.storage.local.get(['maxLength', 'prefix', 'suffix', 'retryCount']).then(async ({ maxLength, prefix, suffix, retryCount }) => {
  const textChunks = splitParagraphText(Number(maxLength) || 4000);
  openChunksPage(textChunks, prefix, suffix, Number(retryCount) || 3);
});
