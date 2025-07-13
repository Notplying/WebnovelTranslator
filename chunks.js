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

function isSessionIncomplete(sessionChunks, totalChunks) {
  if (sessionChunks.length === 0) return false;
  
  let processedCount = 0;
  for (let i = 0; i < totalChunks; i++) {
    if (sessionChunks[i] && sessionChunks[i].content) {
      processedCount++;
    }
  }
  
  return processedCount < totalChunks && processedCount > 0;
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

    // Check for incomplete session
    const incomplete = isSessionIncomplete(sessionChunks, chunks.length);
    if (incomplete) {
      const warningDiv = document.getElementById('incomplete-session-warning');
      if (warningDiv) {
        warningDiv.style.display = 'block';
      }
    }

    // Always set up reprocess all button event listener
    const reprocessAllButton = document.getElementById('reprocess-all-button');
    if (reprocessAllButton) {
      reprocessAllButton.addEventListener('click', () => {
        reprocessAllChunks(chunks, prefix, suffix, retryCount);
      });
    }

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

async function reprocessAllChunks(chunks, prefix, suffix, retryCount) {
  try {
    showFeedback('Starting reprocessing of all chunks...', false);
    
    // Clear all existing chunks from UI
    const chunksContainer = document.getElementById('chunks-container');
    chunksContainer.innerHTML = '';
    
    // Clear all saved chunks for this session
    const sessionId = getSessionId();
    if (!sessionId) {
      showError('No session ID found');
      return;
    }
    
    const { processedChunks = {} } = await browser.storage.local.get('processedChunks');
    processedChunks[sessionId] = [];
    await browser.storage.local.set({ processedChunks });
    
    // Reset progress
    initializeProgress(retryCount, chunks.length);
    
    // Hide warning
    const warningDiv = document.getElementById('incomplete-session-warning');
    if (warningDiv) {
      warningDiv.style.display = 'none';
    }
    
    // Process all chunks from scratch
    processStoredChunks(chunks, prefix, suffix, retryCount);
    
  } catch (error) {
    console.error('Error reprocessing all chunks:', error);
    showError('Failed to reprocess chunks: ' + error.message);
    showFeedback('Failed to reprocess chunks: ' + error.message, true);
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
      updateAttemptProgress(1, retryCount, ProgressState.PROCESSING); // Show processing for this chunk
      const response = await browser.runtime.sendMessage({
        action: 'processChunk',
        chunk: chunks[i],
        prefix: prefix,
        suffix: suffix
      });

      if (response.error) {
        showError(response.error);
        updateAttemptProgress(0, retryCount, ProgressState.ERROR); // Show error for this attempt
        continue;
      }

      // If response is not streamed, it's complete. Add it, then update progress.
      if (!response.streaming) {
        const processedContent = {
          parts: response.parts || [response.result],
          text: response.result
        };
        // addChunk creates the UI and saves to storage.
        // We need to ensure it's displayed before updating progress.
        // The addChunk function itself doesn't return the div, so we find it.
        let chunkDiv = document.getElementById(`chunk-${i}`);
        if (!chunkDiv) {
            // If addChunk hasn't run or finished UI part yet, we might need to call it here
            // or ensure background.js sends an 'addChunk' message for non-streamed.
            // For simplicity, assuming background.js sends 'addChunk' or we call it here.
            // Let's assume background.js sends 'addChunk' message for non-streamed results too.
            // If not, we'd call: await addChunk(i, processedContent, chunks[i]);
            // For now, we expect an 'addChunk' message from background.js for non-streamed.
            // The 'updateProgress' will be triggered by the 'addChunk' message handler
            // or by the 'isComplete' in streaming.

            // Let's explicitly call addChunk here for non-streamed results from processStoredChunks
            // to ensure UI and storage are updated before progress.
            await addChunk(i, processedContent, chunks[i]);
            updateProgress(i + 1, chunks.length); // Update main progress after this chunk is fully processed and saved
          } else {
            // If div exists, it means addChunk was called (e.g. by a message from background)
            // We just need to ensure progress is updated.
            // This path might be redundant if addChunk message handler updates progress.
            // Let's ensure save and then update progress.
            await saveChunkToStorage(i, processedContent, chunks[i]); // Ensure it's saved
            updateProgress(i + 1, chunks.length);
          }
      }
      // For streamed responses, updateProgress will be called by updateStreamingChunk when isComplete is true.
      updateAttemptProgress(0, retryCount, ProgressState.COMPLETED); // Mark attempt as complete

    } catch (error) {
      console.error(`Error processing stored chunk ${i}:`, error);
      showError(error.message);
      updateAttemptProgress(0, retryCount, ProgressState.ERROR);
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
        <li>Enter a valid API key for the selected API provider</li>
        <li>Save the settings</li>
        <li>Try running the extension again</li>
      </ol>
      <p>If you don't have an API key, you can obtain one from the appropriate service provider.</p>
    `
  },
  [ErrorTypes.CONTENT_SAFETY]: {
    title: 'Content Safety Error',
    message: `
      <p>The API provider rejected the content, possibly due to safety concerns, content policies, or potential copyright issues.</p>
      <p>Try changing the prompt suffix or prefix to make the content more acceptable.</p>
    `
  },
  [ErrorTypes.NETWORK]: {
    title: 'Network Error',
    message: 'Failed to connect to the API. Please check your internet connection and try again.'
  },
  [ErrorTypes.PROCESSING]: {
    title: 'Processing Error',
    message: 'An error occurred while processing the chunk. Please check your API settings and try again.'
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
    // Handle various API key errors
    if (error.includes('PERMISSION_DENIED') || 
        error.includes('Please use API Key') || 
        error.includes('Invalid API key') || 
        error.includes('authentication failed')) {
      errorType = ErrorTypes.API_KEY;
    } 
    // Handle content safety errors from different providers
    else if (error.includes('Unexpected response structure from Gemini API') || 
             error.includes('Unexpected response structure from OpenRouter API') ||
             error.includes('content policy')) {
      errorType = ErrorTypes.CONTENT_SAFETY;
    } 
    // Handle network errors
    else if (error.includes('Failed to fetch') || 
             error.includes('Network error') || 
             error.includes('Rate limit exceeded')) {
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
  [ProgressState.INITIALIZING]: 'linear-gradient(to right, #b39ddb, #7e57c2)', // Light Purple to Dark Purple
  [ProgressState.PROCESSING]: 'linear-gradient(to right, #80deea, #00acc1)', // Light Cyan to Dark Cyan
  [ProgressState.COMPLETED]: 'linear-gradient(to right, #a5d6a7, #4caf50)',  // Light Green to Dark Green
  [ProgressState.ERROR]: 'linear-gradient(to right, #ef9a9a, #f44336)'      // Light Red to Dark Red
};

function updateProgressBar(elementId, current, total, state = ProgressState.PROCESSING) {
  const progressBar = document.getElementById(elementId);
  if (!progressBar) {
    console.error(`Progress bar element not found: ${elementId}`);
    return;
  }

  const percentage = Math.min(Math.max((current / total) * 100, 0), 100);
  progressBar.style.width = `${percentage}%`;
  progressBar.style.background = ProgressColors[state]; // Use background for gradients
  progressBar.style.transition = 'width 0.3s ease-in-out, background 0.3s ease-in-out'; // Transition background
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

function updateAttemptProgress(current, total, forceState = null) {
  // Handle forced state (typically for completion)
  if (forceState !== null) {
    updateProgressBar('attempt-progress-bar-fill', current, total, forceState);
    
    // Update text based on state
    const progressText = document.getElementById('attempt-progress-text');
    if (progressText) {
      if (forceState === ProgressState.COMPLETED) {
        progressText.textContent = 'Processing complete';
      } else if (forceState === ProgressState.ERROR) {
        progressText.textContent = 'Error during processing';
      } else if (forceState === ProgressState.INITIALIZING) {
        progressText.textContent = 'Initializing...';
      } else {
        progressText.textContent = `Attempt ${current} of ${total}`;
      }
    }
    return;
  }
  
  // If streaming, show streaming state
  if (isStreaming) {
    updateProgressBar('attempt-progress-bar-fill', 1, 1, ProgressState.PROCESSING);
    const progressText = document.getElementById('attempt-progress-text');
    if (progressText) {
      progressText.textContent = 'Currently Streaming...';
    }
    return;
  }

  // Default state handling
  const state = current === 0 ? ProgressState.COMPLETED :
                current === total ? ProgressState.COMPLETED :
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

async function addChunk(index, content, rawContent) {
  const sessionId = getSessionId();
  if (!sessionId) {
    console.error('No session ID found when adding chunk');
    return;
  }

  try {
    // Store the chunk data under the session ID
    const result = await browser.storage.local.get(['processedChunks', 'translationSessions']);
    const allChunks = result.processedChunks || {};
    const sessionChunks = allChunks[sessionId] || [];
    sessionChunks[index] = { content, rawContent }; // Ensure 'content' is the structured object
    allChunks[sessionId] = sessionChunks;

    // Get the most recent session IDs based on maxSessions setting
    const maxSessions = (await browser.storage.local.get('maxSessions')).maxSessions || 3;
    const recentSessions = (result.translationSessions || [])
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, maxSessions)
      .map(session => session.id);

    // Keep only chunks from recent sessions
    const filteredChunks = {};
    recentSessions.forEach(sid => {
      if (allChunks[sid]) {
        filteredChunks[sid] = allChunks[sid];
      }
    });

    await browser.storage.local.set({ processedChunks: filteredChunks });
    console.log(`addChunk: Successfully saved chunk ${index} for session ${sessionId}`);
  } catch (error) {
    console.error(`addChunk: Error saving chunk ${index} to storage:`, error);
  }

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

  // Apply styles for bottom-stickied notification
  feedback.style.position = 'fixed';
  feedback.style.bottom = '20px';
  feedback.style.left = '50%';
  feedback.style.transform = 'translateX(-50%)';
  feedback.style.padding = '10px 20px';
  feedback.style.backgroundColor = isError ? '#f44336' : '#4caf50'; // Red for error, Green for success
  feedback.style.color = 'white';
  feedback.style.borderRadius = '5px';
  feedback.style.zIndex = '9999'; // Ensure it's on top
  feedback.style.textAlign = 'center';
  feedback.style.boxShadow = '0 2px 10px rgba(0,0,0,0.2)';

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

  // Get the most recent session IDs based on maxSessions setting
  const maxSessions = (await browser.storage.local.get('maxSessions')).maxSessions || 3;
  const recentSessions = (result.translationSessions || [])
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, maxSessions)
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

        // If streaming is enabled, let the streaming handler take care of updates
        if (result.streaming) {
          // The streaming handler will update UI and save automatically
          return;
        }

        const chunkDiv = document.getElementById(`chunk-${index}`);
        if (!chunkDiv) {
          throw new Error('Chunk element not found');
        }

        // Process new content (non-streaming mode)
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
let streamingChunkId = null; // Tracks the ID of the div being streamed into
let lastRawContent = null; // Tracks raw content for the current *new* chunk stream
let saveTimeout = null; // For debouncing save operations
let reprocessingState = { isActive: false, targetIndex: -1, targetElementId: null, originalRawContent: null };

async function reprocessChunk(index, rawContent) {
  try {
    const storedData = await browser.runtime.sendMessage({ action: 'getStoredData' });
    const { prefix, suffix, retryCount } = storedData;
    const sessionId = getSessionId();
    if (!sessionId) throw new Error('No session ID found');

    reprocessingState.isActive = true;
    reprocessingState.targetIndex = index;
    reprocessingState.targetElementId = `chunk-${index}`;
    reprocessingState.originalRawContent = rawContent; // Store the raw content being reprocessed
    console.log(`Reprocessing activated for index: ${index}, ID: ${reprocessingState.targetElementId}`);

    const targetChunkDiv = document.getElementById(reprocessingState.targetElementId);
    if (!targetChunkDiv) {
      console.error(`Cannot reprocess: Chunk element ${reprocessingState.targetElementId} not found.`);
      showError(`Error: UI element for chunk ${index + 1} not found for reprocessing.`);
      throw new Error(`UI element for chunk ${index + 1} not found`);
    }

    const contentPartsDisplay = targetChunkDiv.querySelector('.content-parts');
    if (contentPartsDisplay) contentPartsDisplay.innerHTML = '<p>Reprocessing...</p>';
    const partButtonsDisplay = targetChunkDiv.querySelector('.part-buttons');
    if (partButtonsDisplay) partButtonsDisplay.innerHTML = '';

    showFeedback('Reprocessing chunk...', false);
    updateAttemptProgress(1, retryCount);

    const { processedChunks = {} } = await browser.storage.local.get('processedChunks');
    const sessionChunks = processedChunks[sessionId] || [];
    if (sessionChunks[index]) {
      delete sessionChunks[index];
      processedChunks[sessionId] = sessionChunks;
      await browser.storage.local.set({ processedChunks });
    }

    for (let attempt = 0; attempt < retryCount; attempt++) {
      updateAttemptProgress(attempt + 1, retryCount);
      try {
        const result = await browser.runtime.sendMessage({
          action: 'processChunk',
          chunk: rawContent, // Send the original raw content for reprocessing
          prefix: prefix,
          suffix: suffix
        });

        if (result.error) throw new Error(result.error);

        // If streaming is enabled, let the streaming handler take care of updates
        if (result.streaming) {
          // The streaming handler will update UI and save automatically
          return;
        }

        // Process new content (non-streaming mode)
        const parts = result.parts || [result.result];
        updateChunkContent(targetChunkDiv, parts, index);
        const newProcessedContent = { parts: parts, text: result.result };
        await saveChunkToStorage(index, newProcessedContent, rawContent);
         
        // Update main progress bar
        const { translationSessions = [] } = await browser.storage.local.get('translationSessions');
        const currentSessionId = getSessionId();
        const currentSessionData = translationSessions.find(s => s.id === currentSessionId);
        if (currentSessionData && currentSessionData.chunks) {
          updateProgress(index + 1, currentSessionData.chunks.length);
        } else {
           // Fallback if session data isn't readily available, might need to adjust total
          const totalChunks = document.querySelectorAll('.chunk').length || index + 1;
          updateProgress(index + 1, totalChunks);
        }

        updateAttemptProgress(0, retryCount, ProgressState.COMPLETED);
        showFeedback('Chunk reprocessed successfully!');
        reprocessingState.isActive = false;
        return;

      } catch (error) {
        console.error(`Reprocessing attempt ${attempt + 1} failed:`, error);
        if (error.message.includes("PERMISSION_DENIED") || attempt === retryCount - 1) {
          const errorMessage = `Error reprocessing chunk ${index + 1}: ${error.message}`;
          showError(errorMessage, true);
          showFeedback(errorMessage, true);
          throw error; // Propagate to outer catch for state reset
        }
        await new Promise(resolve => setTimeout(resolve, 7000));
      }
    }
  } catch (error) {
    console.error('Error in reprocessChunk:', error);
    const errorMessage = `Error reprocessing chunk: ${error.message}`;
    showError(errorMessage); // Show general error
    showFeedback(errorMessage, true);
  } finally {
    // Ensure state is reset if not handled by a successful stream completion
    // This is a fallback; ideally, successful stream completion in updateStreamingChunk resets it.
    if (reprocessingState.isActive && !(isStreaming && reprocessingState.targetIndex === currentChunkIndex) ) {
        // Only reset if not actively streaming for this reprocessed chunk
        // This condition might be tricky. The primary reset should be on stream 'isComplete' or non-streamed success/final error.
        // For now, let's rely on updateStreamingChunk for streamed reset.
        // And non-streamed success/error in the loop above.
        // This finally might be too aggressive if a stream is ongoing.
        // Consider removing this or making it more conditional.
        // For now, if an error threw out of the loop, we reset.
         if (!isStreaming || reprocessingState.targetIndex !== currentChunkIndex) { // Avoid resetting if a stream for *this* reprocess is active
            console.log("ReprocessChunk finally: Resetting reprocessing state due to error or non-streamed completion.");
            reprocessingState.isActive = false;
            reprocessingState.targetIndex = -1;
            reprocessingState.targetElementId = null;
            reprocessingState.originalRawContent = null;
        }
    }
  }
}


async function updateStreamingChunk(content, rawContent, isInitial = false, isComplete = false) {
  try {
    let effectiveChunkIndex;
    let effectiveStreamingChunkId;
    let effectiveRawContent = rawContent; // Default to message's rawContent

    if (reprocessingState.isActive) {
      effectiveChunkIndex = reprocessingState.targetIndex;
      effectiveStreamingChunkId = reprocessingState.targetElementId;
      effectiveRawContent = reprocessingState.originalRawContent; // Use the raw content from when reprocessing started
      console.log(`updateStreamingChunk (REPROCESSING): index=${effectiveChunkIndex}, id=${effectiveStreamingChunkId}, isInitial=${isInitial}, isComplete=${isComplete}`);

      if (isInitial) { // First packet of a reprocessing stream
        isStreaming = true; // Mark that a stream is active
        streamingChunkId = effectiveStreamingChunkId; // Global streaming ID points to the reprocessed chunk
        currentChunkIndex = effectiveChunkIndex; // Align global currentChunkIndex for consistency during this stream
        lastRawContent = effectiveRawContent; // Track raw content for this specific stream
        
        const targetChunkDiv = document.getElementById(effectiveStreamingChunkId);
        if (targetChunkDiv) {
            const targetContentParts = targetChunkDiv.querySelector('.content-parts');
            if (targetContentParts && targetContentParts.innerHTML.includes("Reprocessing...")) {
                 targetContentParts.innerHTML = ''; // Clear "Reprocessing..."
            }
            const targetPartButtons = targetChunkDiv.querySelector('.part-buttons');
            if (targetPartButtons) targetPartButtons.innerHTML = '';
        }
        updateAttemptProgress(0, 0); // Show generic streaming state
        // Do not return; proceed to update/create the div content.
      }
    } else { // Normal (non-reprocessing) stream
      console.log(`updateStreamingChunk (NORMAL): isInitial=${isInitial}, isComplete=${isComplete}, globalCurrentChunkIndex=${currentChunkIndex}`);
      if (isInitial) {
        currentChunkIndex++; // A new distinct chunk is starting
        effectiveChunkIndex = currentChunkIndex;
        effectiveStreamingChunkId = `chunk-${effectiveChunkIndex}`;
        console.log(`New chunk starting (NORMAL). EffectiveIndex: ${effectiveChunkIndex}. Raw: ${rawContent ? rawContent.substring(0,20) : 'N/A'}`);

        if (effectiveChunkIndex === 0) { // Clear container only for the very first *new* chunk
          const chunksContainer = document.getElementById('chunks-container');
          if (chunksContainer) chunksContainer.innerHTML = '';
        }
        
        // const { translationSessions = [] } = await browser.storage.local.get('translationSessions');
        // const sessionId = getSessionId();
        // const sessionData = translationSessions.find(s => s.id === sessionId);
        // if (sessionData && sessionData.chunks) {
        //   updateProgress(effectiveChunkIndex + 1, sessionData.chunks.length); // This was the bug, remove it.
        // }

        isStreaming = false; // Not actively streaming content *yet* for this new chunk
        streamingChunkId = null;
        lastRawContent = rawContent;
        return; // Wait for actual content for this new chunk
      }
      // For subsequent packets of a normal stream
      effectiveChunkIndex = currentChunkIndex;
      effectiveStreamingChunkId = `chunk-${effectiveChunkIndex}`;
    }

    // If this is the final update for this chunk
    if (isComplete) {
      if (saveTimeout) clearTimeout(saveTimeout); // Clear any debounced save

      const chunkDiv = document.getElementById(effectiveStreamingChunkId);
      let finalContentToSave = { parts: [content], text: content };

      if (chunkDiv && content) {
        const partContent = chunkDiv.querySelector('.part-content.active');
        if (partContent) {
          partContent.innerHTML = DOMPurify.sanitize(marked.parse(escapeHtml(content)));
          chunkDiv.dataset.rawContent = effectiveRawContent;
        }
        // Ensure finalContentToSave is based on the received 'content' parameter for isComplete
      }
      
      // Explicitly save the final complete content
      await saveChunkToStorage(effectiveChunkIndex, finalContentToSave, effectiveRawContent);
      console.log(`Saved final COMPLETED content for chunk ${effectiveChunkIndex} (ID: ${effectiveStreamingChunkId})`);

      isStreaming = false;
      updateAttemptProgress(1, 1, ProgressState.COMPLETED);
      const progressText = document.getElementById('attempt-progress-text');
      if (progressText) progressText.textContent = 'Chunk completed';
      
      // Update main progress bar *after* saving the completed chunk
      const { translationSessions = [] } = await browser.storage.local.get('translationSessions');
      const currentSessionId = getSessionId();
      const currentSessionData = translationSessions.find(s => s.id === currentSessionId);
      if (currentSessionData && currentSessionData.chunks) {
        updateProgress(effectiveChunkIndex + 1, currentSessionData.chunks.length);
      } else {
        // Fallback if session data isn't readily available
        const totalSessionChunks = document.querySelectorAll('.chunk').length; // Estimate total from UI if needed
        updateProgress(effectiveChunkIndex + 1, totalSessionChunks > 0 ? totalSessionChunks : effectiveChunkIndex + 1);
      }
      
      if (reprocessingState.isActive && reprocessingState.targetIndex === effectiveChunkIndex) {
        console.log(`Reprocessing stream complete for index ${effectiveChunkIndex}. Resetting state.`);
        reprocessingState.isActive = false;
        reprocessingState.targetIndex = -1;
        reprocessingState.targetElementId = null;
        reprocessingState.originalRawContent = null;
      }
      console.log(`Streaming complete and saved for chunk ${effectiveChunkIndex}. Main progress updated.`);
      return;
    }

    // Setup streaming state if not already set (for the first content packet of a normal or reprocessed stream)
    if (!isStreaming) {
      isStreaming = true;
      streamingChunkId = effectiveStreamingChunkId; // Global var tracks current target
      // If reprocessing, currentChunkIndex was already aligned. If normal, it's the current new chunk index.
      console.log(`Starting to stream content for chunk index ${effectiveChunkIndex}. Assigned ID: ${streamingChunkId}`);
      updateAttemptProgress(0, 0);
    }
    
    // Ensure rawContent matches for ongoing stream (sanity check, primarily for non-reprocessing)
    if (!reprocessingState.isActive && rawContent !== lastRawContent) {
        console.warn(`Normal stream: rawContent changed unexpectedly mid-stream for chunk ${effectiveChunkIndex}.`);
    }

    let chunkDiv = document.getElementById(effectiveStreamingChunkId);
  
    const processedContentToSave = { parts: [content], text: content };
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(async () => {
      await saveChunkToStorage(effectiveChunkIndex, processedContentToSave, effectiveRawContent);
    }, 500);

    if (!chunkDiv) { // Create new chunk div (should only happen for new, non-reprocessed chunks)
      if (reprocessingState.isActive) {
        console.error(`Error: Attempted to create a new div for a reprocessed chunk ${effectiveStreamingChunkId}. This should not happen.`);
        // Fallback: try to find it again, or show error. For now, log and proceed cautiously.
        // This indicates a logic flaw if reprocessChunk didn't prepare the div or it got removed.
      }
      const chunksContainer = document.getElementById('chunks-container');
      chunkDiv = document.createElement('div'); // Renamed from chunkElement for consistency
      chunkDiv.id = effectiveStreamingChunkId;
      chunkDiv.className = 'chunk';

      const card = document.createElement('div'); card.className = 'card';
      const cardBody = document.createElement('div'); cardBody.className = 'card-body';
      cardBody.appendChild(createChunkHeader(effectiveChunkIndex));

      const partButtons = document.createElement('div'); partButtons.className = 'part-buttons';
      cardBody.appendChild(partButtons);
      
      const contentParts = document.createElement('div'); contentParts.className = 'content-parts';
      const partContentElement = document.createElement('div'); // Renamed for clarity
      partContentElement.className = 'markdown-content part-content active';
      partContentElement.dataset.part = '0';
      partContentElement.innerHTML = DOMPurify.sanitize(marked.parse(escapeHtml(content)));
      contentParts.appendChild(partContentElement);
      cardBody.appendChild(contentParts);

      const partButton = createPartButton('Part 1', true, () => switchPart(effectiveChunkIndex, 0));
      partButtons.appendChild(partButton);
      chunkDiv.dataset.rawContent = effectiveRawContent;

      const actionButtonsContainer = document.createElement('div');
      actionButtonsContainer.className = 'button-group';
      Object.assign(actionButtonsContainer.style, { display: 'flex', gap: '10px', marginTop: '10px' });

      const copyButton = createButton('Copy Processed Chunk', 'button copy-button', () => copyChunk(effectiveChunkIndex, chunkDiv.querySelector('.part-content.active').textContent, 'processed'));
      const copyRawButton = createButton('Copy Raw Chunk', 'button copy-raw-button', () => copyChunk(effectiveChunkIndex, chunkDiv.dataset.rawContent, 'raw'));
      const reprocessBtn = createButton('Reprocess Chunk', 'button reprocess-button', () => reprocessChunk(effectiveChunkIndex, chunkDiv.dataset.rawContent));
      [copyButton, copyRawButton, reprocessBtn].forEach(button => {
        Object.assign(button.style, { flex: '1', margin: '0' });
        actionButtonsContainer.appendChild(button);
      });
      cardBody.appendChild(actionButtonsContainer);
      const feedback = document.createElement('div'); feedback.className = 'feedback'; feedback.textContent = 'Copied!'; feedback.style.display = 'none';
      cardBody.appendChild(feedback);
      card.appendChild(cardBody);
      chunkDiv.appendChild(card);
      chunksContainer.insertBefore(chunkDiv, null); // Append at the end
    } else { // Update existing chunk content
      const partContent = chunkDiv.querySelector('.part-content.active');
      if (partContent) {
        partContent.innerHTML = DOMPurify.sanitize(marked.parse(escapeHtml(content)));
        // Ensure rawContent dataset is updated if it somehow changed, though for streaming it should be consistent.
        chunkDiv.dataset.rawContent = effectiveRawContent;
      } else {
          // If .part-content.active is missing (e.g. after clearing for reprocess), recreate it.
          const contentPartsContainer = chunkDiv.querySelector('.content-parts');
          if (contentPartsContainer) {
              contentPartsContainer.innerHTML = ''; // Clear any "Reprocessing..."
              const newPartContent = createPartContent(content, true, 0);
              contentPartsContainer.appendChild(newPartContent);

              // Also ensure part button exists
              const partButtonsContainer = chunkDiv.querySelector('.part-buttons');
              if (partButtonsContainer && partButtonsContainer.innerHTML === '') {
                  const newPartButton = createPartButton('Part 1', true, () => switchPart(effectiveChunkIndex, 0));
                  partButtonsContainer.appendChild(newPartButton);
              }
          }
      }
    }
  } catch (error) {
    console.error('Error in updateStreamingChunk:', error);
    showError('Error updating streaming content: ' + error.message);
    // If an error occurs during a reprocess stream, reset the state
    if (reprocessingState.isActive && reprocessingState.targetIndex === (typeof effectiveChunkIndex !== 'undefined' ? effectiveChunkIndex : currentChunkIndex) ) {
        console.log("Resetting reprocessing state due to error in updateStreamingChunk.");
        reprocessingState.isActive = false;
        reprocessingState.targetIndex = -1;
        reprocessingState.targetElementId = null;
        reprocessingState.originalRawContent = null;
    }
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
          break;      case 'updateStreamContent':
          console.log('Received streaming content update:', message.content);
          updateStreamingChunk(message.content, message.rawContent, message.isInitial, message.isComplete);
          break;
  }
});

console.log('Chunks page script loaded');