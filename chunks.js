// Track initialization state
let isInitialized = false;

// Self-initialize when loaded
document.addEventListener('DOMContentLoaded', () => {
  console.log('Chunks page loaded, initializing...');
  if (!isInitialized) {
    initializeChunksPage();
  }
});

browser.runtime.onMessage.addListener((message) => {
  if (message.action === 'initializeChunksPage' && !isInitialized) {
    initializeChunksPage();
  }
});

function getSessionId() {
  const urlParams = new URLSearchParams(window.location.search);
  return urlParams.get('session');
}

async function initializeChunksPage() {
  if (isInitialized) {
    console.log('Page already initialized, skipping...');
    return;
  }

  try {
    console.log('Starting page initialization...');
    isInitialized = true;

    const sessionId = getSessionId();
    if (!sessionId) {
      console.error('No session ID found in URL');
      showError('Invalid session: No session ID found');
      return;
    }

    // Get session data
    const { translationSessions = [] } = await browser.storage.local.get('translationSessions');
    const sessionData = translationSessions.find(s => s.id === sessionId);
    
    if (!sessionData) {
      console.error('Session not found:', sessionId);
      showError('Invalid session: Session not found');
      return;
    }

    // Get processed chunks for this session
    const { processedChunks = {} } = await browser.storage.local.get('processedChunks');
    const sessionChunks = processedChunks[sessionId] || [];

    const { chunks, prefix, suffix, retryCount } = sessionData;

    // Save current chunks data
    await browser.storage.local.set({
      lastChunksData: { chunks, prefix, suffix, retryCount }
    });
    
    // Initialize progress
    initializeProgress(retryCount, chunks.length);
    createChunkButtons(chunks, prefix, suffix);

    if (sessionChunks.length > 0) {
      // Restore stored chunks for this session
      sessionChunks.forEach((chunk, index) => {
        if (chunk) {
          addChunk(index, chunk.content, chunk.rawContent);
          updateProgress(index + 1, chunks.length);
        }
      });
    } else {
      // Process chunks if no stored results exist for this session
      processStoredChunks(chunks, prefix, suffix, retryCount);
    }
  } catch (error) {
    console.error('Error initializing chunks page:', error);
    showError('Failed to initialize page: ' + error.message);
  }
}

function createChunkButtons(chunks, prefix, suffix) {
  const buttonContainer = document.querySelector('.button-container');
  chunks.forEach((chunk, index) => {
    const button = document.createElement('button');
    button.textContent = `Copy Chunk ${index + 1}`;
    button.className = 'button copy-chunk-button';
    button.addEventListener('click', (event) => {
      event.preventDefault();
      copyChunk(index, prefix + chunk + suffix);
      button.classList.add('copied');
    });
    buttonContainer.appendChild(button);
  });
}

async function processStoredChunks(chunks, prefix, suffix, retryCount) {
  for (let i = 0; i < chunks.length; i++) {
    try {
      // Send the chunk for processing
      const response = await browser.runtime.sendMessage({
        action: 'processChunk',
        chunk: chunks[i],
        prefix: prefix,
        suffix: suffix
      });

      if (response.error) {
        showError(response.error);
        continue;
      }

      // Update progress after each chunk
      updateProgress(i + 1, chunks.length);
      updateAttemptProgress(0, retryCount);

    } catch (error) {
      console.error('Error processing chunk:', error);
      showError(error.message);
    }
  }
}


// Error types for better error handling
const ErrorTypes = {
  API_KEY: 'api_key',
  CONTENT_SAFETY: 'content_safety',
  NETWORK: 'network',
  PROCESSING: 'processing',
  FATAL: 'fatal'
};

// Error messages mapping
const ErrorMessages = {
  [ErrorTypes.API_KEY]: {
    title: 'API Key Error',
    message: `
      <p>It seems that the API key is missing or invalid. Please follow these steps:</p>
      <ol>
        <li>Go to the extension settings</li>
        <li>Enter a valid API key for the Gemini API</li>
        <li>Save the settings</li>
        <li>Try running the extension again</li>
      </ol>
      <p>If you don't have an API key, you can obtain one from the Google AI Studio.</p>
    `
  },
  [ErrorTypes.CONTENT_SAFETY]: {
    title: 'Content Safety Error',
    message: `
      <p>Gemini doesn't like the content and deems it 'unsafe' somehow (Unsafe ranges from too 'Spicy' or potential copyright issues).</p>
      <p>Maybe change the prompt suffix or prefix?</p>
    `
  },
  [ErrorTypes.NETWORK]: {
    title: 'Network Error',
    message: 'Failed to connect to the API. Please check your internet connection and try again.'
  },
  [ErrorTypes.PROCESSING]: {
    title: 'Processing Error',
    message: 'An error occurred while processing the chunk. Please try again.'
  },
  [ErrorTypes.FATAL]: {
    title: 'Fatal Error',
    message: 'A critical error occurred. Please refresh the page and try again.'
  }
};

function showError(error, isFatal = false) {
  // Remove any existing error
  const existingError = document.querySelector('.error-container');
  if (existingError) {
    existingError.remove();
  }

  // Determine error type and get corresponding message
  let errorType = ErrorTypes.PROCESSING;
  if (typeof error === 'string') {
    if (error.includes('PERMISSION_DENIED') || error.includes('Please use API Key')) {
      errorType = ErrorTypes.API_KEY;
    } else if (error.includes('Unexpected response structure from Gemini API')) {
      errorType = ErrorTypes.CONTENT_SAFETY;
    } else if (error.includes('Failed to fetch') || error.includes('Network error')) {
      errorType = ErrorTypes.NETWORK;
    }
  }
  if (isFatal) {
    errorType = ErrorTypes.FATAL;
  }

  const errorInfo = ErrorMessages[errorType];
  
  // Create error container
  const errorContainer = document.createElement('div');
  errorContainer.className = 'container error-container';

  // Create error content
  const errorTitle = document.createElement('h1');
  errorTitle.textContent = errorInfo.title;

  const errorMessage = document.createElement('div');
  errorMessage.className = 'error-message';
  errorMessage.innerHTML = errorInfo.message;
  
  // Show the pre-programmed message first
  errorMessage.innerHTML = errorInfo.message;

  // Always add the raw error message if available
  if (error && typeof error === 'string') {
    errorMessage.innerHTML += `<p>original error message: ${error}</p>`;
  }

  // // Assemble and show error
  // errorContainer.appendChild(errorTitle);
  // errorContainer.appendChild(errorMessage);
  // document.body.appendChild(errorContainer);

  // Show feedback notification
  showFeedback(errorInfo.title, true);

  // Update progress bars for fatal errors
  if (isFatal) {
    const attemptProgressText = document.getElementById('attempt-progress-text');
    const progressText = document.getElementById('progress-text');
    
    if (attemptProgressText) attemptProgressText.textContent = 'FATAL ERROR OCCURRED';
    if (progressText) progressText.textContent = 'FATAL ERROR OCCURRED';
  }
}

// Progress state management
const ProgressState = {
  INITIALIZING: 'initializing',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  ERROR: 'error'
};

// Progress bar colors
const ProgressColors = {
  [ProgressState.INITIALIZING]: '#bb86fc',
  [ProgressState.PROCESSING]: '#03dac6',
  [ProgressState.COMPLETED]: '#4CAF50',
  [ProgressState.ERROR]: '#cf6679'
};

function updateProgressBar(elementId, current, total, state = ProgressState.PROCESSING) {
  const progressBar = document.getElementById(elementId);
  if (!progressBar) {
    console.error(`Progress bar element not found: ${elementId}`);
    return;
  }

  const percentage = Math.min(Math.max((current / total) * 100, 0), 100);
  progressBar.style.width = `${percentage}%`;
  progressBar.style.backgroundColor = ProgressColors[state];
  progressBar.style.transition = 'width 0.3s ease-in-out, background-color 0.3s ease-in-out';
}

function updateProgress(current, total) {
  const state = current === total ? ProgressState.COMPLETED : ProgressState.PROCESSING;
  updateProgressBar('progress-bar-fill', current, total, state);
  
  const progressText = document.getElementById('progress-text');
  if (progressText) {
    progressText.textContent = `${current}/${total} chunks processed`;
    
    // Show completion feedback
    if (current === total) {
      showFeedback('All chunks processed successfully!');
    }
  }
}

function updateAttemptProgress(current, total) {
  // If streaming, show special state
  if (isStreaming) {
    updateProgressBar('attempt-progress-bar-fill', 1, 1, ProgressState.COMPLETED);
    const progressText = document.getElementById('attempt-progress-text');
    if (progressText) {
      progressText.textContent = 'Currently Streaming...';
    }
    return;
  }

  // Normal progress behavior when not streaming
  const state = current === 0 ? ProgressState.COMPLETED :
                current === total ? ProgressState.ERROR :
                ProgressState.PROCESSING;
                
  updateProgressBar('attempt-progress-bar-fill', current, total, state);
  
  const progressText = document.getElementById('attempt-progress-text');
  if (progressText) {
    if (current === 0) {
      progressText.textContent = 'Ready for next chunk';
    } else {
      progressText.textContent = `Attempt ${current}/${total}`;
    }
  }
}

function initializeProgress(retryCount, totalChunks) {
  // Initialize both progress bars
  updateProgressBar('attempt-progress-bar-fill', 0, retryCount, ProgressState.INITIALIZING);
  updateProgressBar('progress-bar-fill', 0, totalChunks, ProgressState.INITIALIZING);
  
  // Set initial text
  const attemptText = document.getElementById('attempt-progress-text');
  const progressText = document.getElementById('progress-text');
  
  if (attemptText) attemptText.textContent = 'Ready to start';
  if (progressText) progressText.textContent = `0/${totalChunks} chunks processed`;
  
  // Show initial feedback
  // showFeedback('Starting chunk processing...', false);
}

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Helper functions for creating UI elements
function createButton(text, className, clickHandler) {
  const button = document.createElement('button');
  button.textContent = text;
  button.className = className;
  if (clickHandler) {
    button.addEventListener('click', clickHandler);
  }
  return button;
}

function createPartButton(text, isActive, clickHandler) {
  const className = 'button part-button' + (isActive ? ' active' : '');
  return createButton(text, className, clickHandler);
}

function createPartContent(content, isActive, partIndex) {
  const partContent = document.createElement('div');
  partContent.className = 'markdown-content part-content' + (isActive ? ' active' : '');
  partContent.dataset.part = partIndex;
  const escapedContent = escapeHtml(typeof content === 'string' ? content : content.text || '');
  partContent.innerHTML = DOMPurify.sanitize(marked.parse(escapedContent));
  return partContent;
}

function createChunkHeader(index) {
  const header = document.createElement('div');
  const title = document.createElement('strong');
  title.textContent = `Chunk ${index + 1}:`;
  header.appendChild(title);
  header.appendChild(document.createElement('br'));
  return header;
}

function addChunk(index, content, rawContent) {
  const sessionId = getSessionId();
  if (!sessionId) {
    console.error('No session ID found when adding chunk');
    return;
  }

  // Store the chunk data under the session ID
  browser.storage.local.get(['processedChunks', 'translationSessions']).then(result => {
    const allChunks = result.processedChunks || {};
    const sessionChunks = allChunks[sessionId] || [];
    sessionChunks[index] = { content, rawContent };
    allChunks[sessionId] = sessionChunks;

    // Get the 3 most recent session IDs
    const recentSessions = (result.translationSessions || [])
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 3)
      .map(session => session.id);

    // Keep only chunks from recent sessions
    const filteredChunks = {};
    recentSessions.forEach(sid => {
      if (allChunks[sid]) {
        filteredChunks[sid] = allChunks[sid];
      }
    });

    browser.storage.local.set({ processedChunks: filteredChunks });
  });

  const chunksContainer = document.getElementById('chunks-container');
  const chunkDiv = document.createElement('div');
  chunkDiv.id = 'chunk-' + index;
  chunkDiv.className = 'chunk';

  const card = document.createElement('div');
  card.className = 'card';
  const cardBody = document.createElement('div');
  cardBody.className = 'card-body';

  // Add chunk header
  cardBody.appendChild(createChunkHeader(index));

  // Create containers for parts
  const partButtons = document.createElement('div');
  partButtons.className = 'part-buttons';
  const contentParts = document.createElement('div');
  contentParts.className = 'content-parts';

  // Process content parts
  const parts = content.parts && Array.isArray(content.parts) ? content.parts : [content];
  parts.forEach((part, partIndex) => {
    const isActive = (parts.length === 1 && partIndex === 0) || (parts.length > 1 && partIndex === 1);
    
    // Create part button
    const button = createPartButton(
      `Part ${partIndex + 1}`,
      isActive,
      () => switchPart(index, partIndex)
    );
    partButtons.appendChild(button);

    // Create part content
    const partContent = createPartContent(part, isActive, partIndex);
    contentParts.appendChild(partContent);
  });

  // Add parts to card
  cardBody.appendChild(partButtons);
  cardBody.appendChild(contentParts);

  // Create action buttons container
  const actionButtonsContainer = document.createElement('div');
  actionButtonsContainer.className = 'button-group';
  actionButtonsContainer.style.display = 'flex';
  actionButtonsContainer.style.gap = '10px';
  actionButtonsContainer.style.marginTop = '10px';

  // Add action buttons
  const actionButtons = [
    createButton('Copy Processed Chunk', 'button copy-button', () => {
      const activePart = contentParts.querySelector('.part-content.active');
      const activePartIndex = parseInt(activePart.dataset.part);
      copyChunk(index, parts[activePartIndex], 'processed');
    }),
    createButton('Copy Raw Chunk', 'button copy-raw-button', () => copyChunk(index, rawContent, 'raw')),
    createButton('Reprocess Chunk', 'button reprocess-button', () => reprocessChunk(index, rawContent))
  ];

  // Add buttons to container with equal flex
  actionButtons.forEach(button => {
    button.style.flex = '1';
    button.style.margin = '0';
    actionButtonsContainer.appendChild(button);
  });

  cardBody.appendChild(actionButtonsContainer);

  // Add feedback element (hidden by default)
  const feedback = document.createElement('div');
  feedback.className = 'feedback';
  feedback.textContent = 'Copied!';
  feedback.style.display = 'none';
  cardBody.appendChild(feedback);

  // Assemble and append the chunk
  card.appendChild(cardBody);
  chunkDiv.appendChild(card);
  chunksContainer.appendChild(chunkDiv);
}

function switchPart(chunkIndex, partIndex) {
  const chunkDiv = document.getElementById(`chunk-${chunkIndex}`);
  
  // Update button states
  const buttons = chunkDiv.querySelectorAll('.part-button');
  buttons.forEach((btn, idx) => {
    btn.classList.toggle('active', idx === partIndex);
  });

  // Update content visibility
  const contents = chunkDiv.querySelectorAll('.part-content');
  contents.forEach((content, idx) => {
    content.classList.toggle('active', idx === partIndex);
  });
}

function showFeedback(message, isError = false) {
  // Remove any existing feedback
  const existingFeedback = document.querySelector('.feedback-message');
  if (existingFeedback) {
    existingFeedback.remove();
  }

  const feedback = document.createElement('div');
  feedback.className = `feedback-message ${isError ? 'error' : 'success'}`;
  feedback.textContent = message;
  document.body.appendChild(feedback);

  // Remove the feedback after animation
  setTimeout(() => {
    feedback.remove();
  }, 2000);
}

async function copyChunk(index, content, buttonType = 'processed') {
  try {
    await navigator.clipboard.writeText(content);
    
    // Get the chunk div and its elements
    const chunkDiv = document.getElementById(`chunk-${index}`);
    if (!chunkDiv) return;

    // Show the local feedback element
    const localFeedback = chunkDiv.querySelector('.feedback');
    if (localFeedback) {
      localFeedback.style.display = 'inline-block';
      setTimeout(() => {
        localFeedback.style.display = 'none';
      }, 2000);
    }

    // Update the clicked button's state
    const clickedButton = chunkDiv.querySelector(buttonType === 'raw' ? '.copy-raw-button' : '.copy-button');
    if (clickedButton) {
      clickedButton.classList.add('copied');
      setTimeout(() => {
        clickedButton.classList.remove('copied');
      }, 2000);
    }

    // Only update the container button for processed chunks
    if (buttonType === 'processed') {
      const containerButton = document.querySelector(`.button-container .copy-chunk-button:nth-child(${index + 1})`);
      if (containerButton) {
        containerButton.classList.add('copied');
        setTimeout(() => {
          containerButton.classList.remove('copied');
        }, 2000);
      }
    }

    // Show global feedback
    showFeedback('Copied successfully!');
  } catch (err) {
    console.error('Failed to copy:', err);
    showFeedback('Failed to copy text to clipboard', true);
  }
}

// Utility function to update chunk content
function updateChunkContent(chunkDiv, parts, index) {
  const contentParts = chunkDiv.querySelector('.content-parts');
  const partButtons = chunkDiv.querySelector('.part-buttons');
  
  if (!contentParts || !partButtons) {
    throw new Error('Required elements not found');
  }

  // Clear existing content
  contentParts.innerHTML = '';
  partButtons.innerHTML = '';

  // Add new parts
  parts.forEach((part, partIndex) => {
    const isActive = partIndex === 0;
    
    // Add part button
    const button = createPartButton(
      `Part ${partIndex + 1}`,
      isActive,
      () => switchPart(index, partIndex)
    );
    partButtons.appendChild(button);

    // Add part content
    const partContent = createPartContent(part, isActive, partIndex);
    contentParts.appendChild(partContent);
  });

  return { contentParts, partButtons };
}

// Utility function to update copy button handler
function updateCopyButtonHandler(copyButton, contentParts, parts, index) {
  if (!copyButton) return;

  const newHandler = () => {
    const activePart = contentParts.querySelector('.part-content.active');
    if (activePart) {
      const activePartIndex = parseInt(activePart.dataset.part);
      copyChunk(index, parts[activePartIndex]);
    }
  };
  
  // Remove old handler if it exists
  if (copyButton.clickHandler) {
    copyButton.removeEventListener('click', copyButton.clickHandler);
  }
  
  copyButton.clickHandler = newHandler;
  copyButton.addEventListener('click', newHandler);
}

// Helper function to save chunk to storage without updating UI
async function saveChunkToStorage(index, content, rawContent) {
  const sessionId = getSessionId();
  if (!sessionId) {
    console.error('No session ID found when saving chunk');
    return;
  }

  // Store the chunk data under the session ID
  const result = await browser.storage.local.get(['processedChunks', 'translationSessions']);
  const allChunks = result.processedChunks || {};
  const sessionChunks = allChunks[sessionId] || [];
  sessionChunks[index] = { content, rawContent };
  allChunks[sessionId] = sessionChunks;

  // Get the 3 most recent session IDs
  const recentSessions = (result.translationSessions || [])
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 3)
    .map(session => session.id);

  // Keep only chunks from recent sessions
  const filteredChunks = {};
  recentSessions.forEach(sid => {
    if (allChunks[sid]) {
      filteredChunks[sid] = allChunks[sid];
    }
  });

  await browser.storage.local.set({ processedChunks: filteredChunks });
  console.log(`Saved chunk ${index} to storage for session ${sessionId}`);
}

async function reprocessChunk(index, rawContent) {
  try {
    // Get stored settings
    const storedData = await browser.runtime.sendMessage({ action: 'getStoredData' });
    const { prefix, suffix, retryCount } = storedData;

    // Get session ID
    const sessionId = getSessionId();
    if (!sessionId) {
      throw new Error('No session ID found');
    }

    // Show processing state
    showFeedback('Reprocessing chunk...', false);
    updateAttemptProgress(1, retryCount);

    // Step 1: Delete the saved result for the current session first
    const { processedChunks = {} } = await browser.storage.local.get('processedChunks');
    const sessionChunks = processedChunks[sessionId] || [];
    
    // Remove the chunk at the specified index
    if (sessionChunks[index]) {
      console.log(`Deleting saved result for chunk ${index} in session ${sessionId}`);
      delete sessionChunks[index];
      processedChunks[sessionId] = sessionChunks;
      await browser.storage.local.set({ processedChunks });
    }

    // Step 2: Process the chunk
    for (let attempt = 0; attempt < retryCount; attempt++) {
      updateAttemptProgress(attempt + 1, retryCount);

      try {
        const result = await browser.runtime.sendMessage({
          action: 'processChunk',
          chunk: rawContent,
          prefix: prefix,
          suffix: suffix
        });

        if (result.error) {
          throw new Error(result.error);
        }

        const chunkDiv = document.getElementById(`chunk-${index}`);
        if (!chunkDiv) {
          throw new Error('Chunk element not found');
        }

        // Process new content
        const parts = result.parts || [result.result];
        const { contentParts } = updateChunkContent(chunkDiv, parts, index);

        // Update copy button
        const copyButton = chunkDiv.querySelector('.copy-button');
        updateCopyButtonHandler(copyButton, contentParts, parts, index);

        // Step 3: Save the new result to storage
        const content = {
          parts: parts,
          text: result.result
        };
        
        // Save the new result to storage without updating UI
        await saveChunkToStorage(index, content, rawContent);

        // Reset progress and show success
        updateAttemptProgress(0, retryCount);
        showFeedback('Chunk reprocessed successfully!');
        return;
      } catch (error) {
        console.error(`Attempt ${attempt + 1} failed:`, error);

        if (error.message.includes("PERMISSION_DENIED") ||
            error.message.includes("Please use API Key") ||
            error.message.includes("Unexpected response structure from Gemini API") ||
            attempt === retryCount - 1) {
          
          const errorMessage = `Error reprocessing chunk ${index + 1}: ${error.message}`;
          showError(errorMessage, true);
          showFeedback(errorMessage, true);
          return;
        }

        // Wait before next attempt
        await new Promise(resolve => setTimeout(resolve, 7000));
      }
    }
  } catch (error) {
    console.error('Error in reprocessChunk:', error);
    const errorMessage = `Error reprocessing chunk ${index + 1}: ${error.message}`;
    showError(errorMessage);
    showFeedback(errorMessage, true);
  }
}

let currentChunkIndex = -1;  // Start at -1 so first increment makes it 0
let isStreaming = false;
let streamingChunkId = null;
let lastRawContent = null;
let saveTimeout = null; // For debouncing save operations

async function updateStreamingChunk(content, rawContent) {
  try {
    // Update attempt progress to show streaming state
  updateAttemptProgress(0, 0);

  // If raw content changes, it means we're starting a new chunk
  if (rawContent !== lastRawContent) {
    isStreaming = false;
    streamingChunkId = null;
    lastRawContent = rawContent;
    // Increment chunk index when starting a new chunk
    currentChunkIndex++;
    // Update progress to show correct chunk number
    updateProgress(currentChunkIndex + 1, totalChunks);
  }

  // Create new streaming chunk ID for new chunks
  if (!isStreaming) {
    isStreaming = true;
    streamingChunkId = `chunk-${currentChunkIndex}`;
    // Reset the container if this is the first chunk
    if (currentChunkIndex === 0) {
      document.getElementById('chunks-container').innerHTML = '';
    }
  }

  const chunkDiv = document.getElementById(streamingChunkId);
  
  // Prepare processed content
  const processedContent = {
    parts: [content],
    text: content
  };

  // Clear any existing save timeout
  if (saveTimeout) {
    clearTimeout(saveTimeout);
  }

  // Set a new timeout to save content after 500ms
  saveTimeout = setTimeout(async () => {
    await saveChunkToStorage(currentChunkIndex, processedContent, rawContent);
  }, 500);

  if (!chunkDiv) {
    // Create new chunk div
    const chunksContainer = document.getElementById('chunks-container');
    const chunkElement = document.createElement('div');
    chunkElement.id = `chunk-${currentChunkIndex}`;
    chunkElement.className = 'chunk';

    const card = document.createElement('div');
    card.className = 'card';
    const cardBody = document.createElement('div');
    cardBody.className = 'card-body';

    // Add chunk header
    cardBody.appendChild(createChunkHeader(currentChunkIndex));

    // Create part buttons container
    const partButtons = document.createElement('div');
    partButtons.className = 'part-buttons';
    cardBody.appendChild(partButtons);
    
    // Create content container
    const contentParts = document.createElement('div');
    contentParts.className = 'content-parts';
    const partContent = document.createElement('div');
    partContent.className = 'markdown-content part-content active';
    partContent.dataset.part = '0';
    const escapedContent = escapeHtml(content);
    partContent.innerHTML = DOMPurify.sanitize(marked.parse(escapedContent));
    contentParts.appendChild(partContent);
    cardBody.appendChild(contentParts);

    // Create part button
    const button = createPartButton('Part 1', true, () => switchPart(currentChunkIndex, 0));
    partButtons.appendChild(button);

    // Store raw content for reprocessing
    chunkElement.dataset.rawContent = rawContent;

    // Create action buttons container
    const actionButtonsContainer = document.createElement('div');
    actionButtonsContainer.className = 'button-group';
    actionButtonsContainer.style.display = 'flex';
    actionButtonsContainer.style.gap = '10px';
    actionButtonsContainer.style.marginTop = '10px';

    // Add action buttons
    const copyButton = createButton('Copy Processed Chunk', 'button copy-button', () => {
      const content = chunkElement.querySelector('.part-content.active').textContent;
      copyChunk(currentChunkIndex, content, 'processed');
    });
    const copyRawButton = createButton('Copy Raw Chunk', 'button copy-raw-button', () => {
      copyChunk(currentChunkIndex, chunkElement.dataset.rawContent, 'raw');
    });
    const reprocessButton = createButton('Reprocess Chunk', 'button reprocess-button', () => {
      reprocessChunk(currentChunkIndex, chunkElement.dataset.rawContent);
    });

    // Style buttons
    [copyButton, copyRawButton, reprocessButton].forEach(button => {
      button.style.flex = '1';
      button.style.margin = '0';
      actionButtonsContainer.appendChild(button);
    });

    cardBody.appendChild(actionButtonsContainer);

    // Add feedback element
    const feedback = document.createElement('div');
    feedback.className = 'feedback';
    feedback.textContent = 'Copied!';
    feedback.style.display = 'none';
    cardBody.appendChild(feedback);

    card.appendChild(cardBody);
    chunkElement.appendChild(card);
    // Always append new chunks at the end
    chunksContainer.insertBefore(chunkElement, null);
  } else {
    // Update existing chunk content
    const partContent = chunkDiv.querySelector('.part-content.active');
    if (partContent) {
      const escapedContent = escapeHtml(content);
      partContent.innerHTML = DOMPurify.sanitize(marked.parse(escapedContent));
      chunkDiv.dataset.rawContent = rawContent; // Update raw content for existing chunk
    }
  }
  } catch (error) {
    console.error('Error in updateStreamingChunk:', error);
    showError('Error updating streaming content: ' + error.message);
  }
}

browser.runtime.onMessage.addListener((message) => {
  console.log('Received message:', message);
  switch (message.action) {
      case 'initializeProgress':
          initializeProgress(message.retryCount, message.totalChunks);
          break;
      case 'updateProgress':
          updateProgress(message.current, message.total);
          // Only update currentChunkIndex if not in streaming mode
          if (!isStreaming) {
              currentChunkIndex = message.current - 1;
          }
          // Reset streaming state when chunk is complete and ensure last save completes
          if (saveTimeout) {
            clearTimeout(saveTimeout);
            saveTimeout = null;
            
            // Ensure final save completes when streaming ends
            const chunkDiv = document.getElementById(streamingChunkId);
            if (chunkDiv && isStreaming) {
              const content = chunkDiv.querySelector('.part-content.active')?.innerHTML;
              const rawContent = chunkDiv.dataset.rawContent;
              if (content && rawContent) {
                saveChunkToStorage(currentChunkIndex, {
                  parts: [content],
                  text: content
                }, rawContent);
              }
            }
          }
          isStreaming = false;
          streamingChunkId = null;
          break;
      case 'updateAttemptProgress':
          updateAttemptProgress(message.current, message.total);
          break;
      case 'addChunk':
          if (!isStreaming) { // Only add chunk if not currently streaming
            addChunk(message.index, message.content);
          }
          break;
      case 'showError':
          showError(message.errorContent, message.isFatal);
          break;
      case 'updateStreamContent':
          console.log('Received streaming content update:', message.content);
          updateStreamingChunk(message.content, message.rawContent);
          break;
  }
});

console.log('Chunks page script loaded');