// content.js — MV3 cross-browser via browser-polyfill
// The `browser` global is available via the polyfill loaded before this script.

function splitParagraphText(lengthinput) {
  let maxLength = Math.max(1, Number(lengthinput) || 4000); // Ensure positive chunk size
  console.log('maxLength in splitParagraphText:', maxLength);
  let paragraphId = 1;
  let combinedContent = "";
  const MAX_PARAGRAPHS = 100000; // Safety bound for paragraph loop

  let textLeftDiv = document.querySelector('.text-left');
  let novel_contentDiv = document.querySelector('#novel_content');

  function extractContentWithImages(element) {
    let content = "";
    try {
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
    } catch (e) {
      console.warn('DOM mutation during content extraction, stopping:', e);
    }
    return content;
  }

  if (textLeftDiv) {
    let children = textLeftDiv.childNodes;
    children.forEach(node => {
      if (node.nodeType === Node.ELEMENT_NODE && node.tagName.toLowerCase() === 'p') {
        combinedContent += node.innerHTML + '\n\n';
      } else if (node.nodeType === Node.TEXT_NODE && node.textContent.trim() !== '') {
        let lines = node.textContent.trim().split(']');
        lines.forEach((line, idx) => {
          if (line.trim() !== '') {
            // Re-append ']' only for segments that were followed by a ']' in the original text.
            // The final segment from split(']') never had a trailing ']'.
            const suffix = idx < lines.length - 1 ? ']' : '';
            combinedContent += line.trim() + suffix + '\n\n';
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
  } else if (document.querySelector('.content.py-5')) {
    // novel543.com scraper: extract direct <p> children only, skipping
    // ad blocks, VIP promos, and warnings nested inside child <div>s
    const h1 = document.querySelector('h1');
    if (h1?.textContent?.trim()) {
      combinedContent += h1.textContent.trim() + '\n\n';
    }
    const contentEl = document.querySelector('.content.py-5');
    const directPs = contentEl.querySelectorAll(':scope > p');
    directPs.forEach(p => {
      const text = p.textContent?.trim();
      if (text) {
        combinedContent += text + '\n\n';
      }
    });
  } else {
    while (paragraphId <= MAX_PARAGRAPHS) {
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

async function openChunksPage(chunks, prefix, suffix, retryCount) {
  try {
    await browser.runtime.sendMessage({
      action: 'openChunksPage',
      chunks: chunks,
      prefix: prefix,
      suffix: suffix,
      retryCount: retryCount
    });
  } catch (e) {
    console.error('Failed to open chunks page:', e);
  }
}

browser.storage.local.get(['maxLength', 'prefix', 'suffix', 'retryCount']).then(async ({ maxLength, prefix, suffix, retryCount }) => {
  try {
    const textChunks = splitParagraphText(Number(maxLength) || 4000);
    openChunksPage(textChunks, prefix, suffix, Number(retryCount) || 3);
  } catch (e) {
    console.error('Failed to extract content:', e);
  }
}).catch(err => {
  console.error('Failed to load settings from storage:', err);
});
