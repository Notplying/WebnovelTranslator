# WebnovelTranslator

I know the code's a mess it's originally for my own personal use, started with minimal knowledge, and half-ass AI use, so don't look at it too closely

A Firefox browser extension that helps translate webnovels using AI technology. This extension enhances your reading experience by providing seamless translation capabilities directly in your browser.

## Installation

You can install this extension from the Firefox Add-ons Store:
[AI Webnovel Translator on Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/ai-webnovel-translator/)

## Features

- AI-powered translation for webnovels
- Browser-integrated translation interface
- Support for multiple webnovel sites
- Customizable translation options through the extension settings

## Usage

1. Install the extension from the Firefox Add-ons Store
2. Click on the extension icon in your browser toolbar
3. Configure your translation preferences and API keys in the options page
4. Navigate to a webnovel page
5. Use the extension's interface to translate the content

## Few-Shot Examples

The translator can prepend recent (raw → translation) pairs to the prompt as
few-shot examples, improving consistency in terminology and style.

- **Enable** it under **Options → Few-Shot Examples** and turn on "Enable few-shot examples".
- **Number of examples per request** controls how many pairs are sent. Set to `0` to disable.
- **Custom examples (persistent):** add your own raw/translation pairs that always go first
  and survive rotation — useful for pinning a canonical translation of a tricky term.
- **Recent translations (auto pool):** fills automatically as you translate. The most recent
  translations are used first. Custom examples take priority within the count cap.

### Provider notes

- **Gemini, OpenRouter, OpenAI** (API providers): examples are sent as proper alternating
  user/assistant message turns. Successful translations are automatically saved to the pool.
  Set each provider's **context window** so the extension can drop examples that would
  overflow the model's limit.
- **ChatGPT Web / Gemini Web** (web automation): examples are prepended as an inline text
  block. Web automation does not read the translation back, so it **cannot feed the auto
  pool** — use custom examples, or translate with an API provider first to populate the pool.

## Technical Details

The extension is built using:
- JavaScript for core functionality
- HTML/CSS for the user interface
- External libraries:
  - jsrsasign for security features
  - marked.min.js for markdown processing
  - purify.min.js for content sanitization

## Contributing

While this is primarily a personal project, contributions and suggestions for improvements are welcome. Please ensure you test your changes thoroughly before submitting any pull requests.

## License

This project is licensed under the terms included in the LICENSE file. See the [LICENSE](LICENSE) file for details.