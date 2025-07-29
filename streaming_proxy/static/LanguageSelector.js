// Language Selector Component
class LanguageSelector {
  constructor() {
    this.languages = {
      'en': { name: 'English', native: 'English', flag: '🇺🇸' },
      'hi': { name: 'Hindi', native: 'हिंदी', flag: '🇮🇳' },
      'bn': { name: 'Bengali', native: 'বাংলা', flag: '🇧🇩' },
      'ta': { name: 'Tamil', native: 'தமிழ்', flag: '🇮🇳' },
      'te': { name: 'Telugu', native: 'తెలుగు', flag: '🇮🇳' },
      'mr': { name: 'Marathi', native: 'मराठी', flag: '🇮🇳' },
      'gu': { name: 'Gujarati', native: 'ગુજરાતી', flag: '🇮🇳' },
      'kn': { name: 'Kannada', native: 'ಕನ್ನಡ', flag: '🇮🇳' },
      'ml': { name: 'Malayalam', native: 'മലയാളം', flag: '🇮🇳' },
      'pa': { name: 'Punjabi', native: 'ਪੰਜਾਬੀ', flag: '🇮🇳' },
      'ur': { name: 'Urdu', native: 'اردو', flag: '🇵🇰' },
      'as': { name: 'Assamese', native: 'অসমীয়া', flag: '🇮🇳' },
      'or': { name: 'Odia', native: 'ଓଡ଼ିଆ', flag: '🇮🇳' },
      'ne': { name: 'Nepali', native: 'नेपाली', flag: '🇳🇵' },
      'sa': { name: 'Sanskrit', native: 'संस्कृतम्', flag: '🇮🇳' }
    };
    this.currentLanguage = this.getCurrentLanguage();
    this.init();
  }

  // Get current language from URL or localStorage
  getCurrentLanguage() {
    // First check URL
    const pathSegments = window.location.pathname.split('/');
    if (pathSegments[1] && this.languages[pathSegments[1]]) {
      return pathSegments[1];
    }
    // Fallback to localStorage
    return localStorage.getItem('selectedLanguage') || 'en';
  }

  // Initialize the language selector
  init() {
    this.createLanguageButton();
    this.createLanguageDialog();
    this.bindEvents();
    this.updateCurrentLanguage();
  }

  // Create the language button
  createLanguageButton() {
    const button = document.createElement('div');
    button.id = 'language-selector-btn';
    button.className = 'language-selector-btn';
    button.innerHTML = `
      <span class="flag">${this.languages[this.currentLanguage]?.flag || '🌐'}</span>
      <span class="text">${this.languages[this.currentLanguage]?.native || 'Language'}</span>
      <span class="arrow">▼</span>
    `;
    // Add styles
    const style = document.createElement('style');
    style.textContent = `
      .language-selector-btn {
        position: fixed !important;
        top: 20px !important;
        right: 20px !important;
        background: rgba(255, 255, 255, 0.95) !important;
        border: 2px solid #007bff !important;
        border-radius: 25px !important;
        padding: 8px 16px !important;
        cursor: pointer !important;
        display: flex !important;
        align-items: center !important;
        gap: 8px !important;
        font-size: 14px !important;
        font-weight: 500 !important;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15) !important;
        z-index: 999999 !important;
        transition: all 0.3s ease !important;
        backdrop-filter: blur(10px) !important;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif !important;
      }
      .language-selector-btn:hover {
        background: rgba(255, 255, 255, 1);
        transform: translateY(-2px);
        box-shadow: 0 6px 20px rgba(0, 0, 0, 0.2);
      }
      .language-selector-btn .flag {
        font-size: 16px;
      }
      .language-selector-btn .text {
        color: #333;
      }
      .language-selector-btn .arrow {
        font-size: 10px;
        color: #007bff;
        transition: transform 0.3s ease;
      }
      .language-selector-btn.active .arrow {
        transform: rotate(180deg);
      }
      .language-dialog {
        position: fixed !important;
        top: 70px !important;
        right: 20px !important;
        background: white !important;
        border-radius: 12px !important;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2) !important;
        padding: 16px !important;
        max-height: 400px !important;
        overflow-y: auto !important;
        z-index: 999998 !important;
        display: none !important;
        backdrop-filter: blur(10px) !important;
        border: 1px solid rgba(255, 255, 255, 0.2) !important;
        min-width: 200px !important;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif !important;
      }
      .language-dialog.show {
        display: block !important;
        animation: slideIn 0.3s ease !important;
        visibility: visible !important;
        opacity: 1 !important;
      }
      @keyframes slideIn {
        from {
          opacity: 0;
          transform: translateY(-10px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }
      .language-option {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 10px 12px;
        cursor: pointer;
        border-radius: 8px;
        transition: background 0.2s ease;
        border: none;
        background: none;
        width: 100%;
        text-align: left;
        font-size: 14px;
      }
      .language-option:hover {
        background: #f8f9fa;
      }
      .language-option.active {
        background: #e3f2fd;
        color: #1976d2;
        font-weight: 500;
      }
      .language-option .flag {
        font-size: 18px;
        width: 24px;
        text-align: center;
      }
      .language-option .name {
        font-weight: 500;
        color: #333;
      }
      .language-option .native {
        font-size: 12px;
        color: #666;
        margin-left: auto;
      }
      .language-dialog-header {
        font-size: 16px;
        font-weight: 600;
        color: #333;
        margin-bottom: 12px;
        padding-bottom: 8px;
        border-bottom: 1px solid #eee;
      }
      .language-dialog-footer {
        margin-top: 12px;
        padding-top: 8px;
        border-top: 1px solid #eee;
        font-size: 12px;
        color: #666;
        text-align: center;
      }
    `;
    document.head.appendChild(style);
    document.body.appendChild(button);
  }

  // Create the language dialog
  createLanguageDialog() {
    const dialog = document.createElement('div');
    dialog.id = 'language-dialog';
    dialog.className = 'language-dialog';
    let optionsHTML = '<div class="language-dialog-header">Select Language</div>';
    Object.entries(this.languages).forEach(([code, lang]) => {
      const isActive = code === this.currentLanguage;
      optionsHTML += `
        <button class="language-option ${isActive ? 'active' : ''}" data-lang="${code}">
          <span class="flag">${lang.flag}</span>
          <span class="name">${lang.name}</span>
          <span class="native">${lang.native}</span>
        </button>
      `;
    });
    optionsHTML += '<div class="language-dialog-footer">Language selection will persist across pages</div>';
    dialog.innerHTML = optionsHTML;
    document.body.appendChild(dialog);
  }

  // Bind events
  bindEvents() {
    const button = document.getElementById('language-selector-btn');
    const dialog = document.getElementById('language-dialog');
    button.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleDialog();
    });
    document.addEventListener('click', (e) => {
      if (!dialog.contains(e.target) && !button.contains(e.target)) {
        this.hideDialog();
      }
    });
    dialog.addEventListener('click', (e) => {
      if (e.target.closest('.language-option')) {
        const langCode = e.target.closest('.language-option').dataset.lang;
        this.selectLanguage(langCode);
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.hideDialog();
      }
    });
  }

  // Toggle dialog visibility
  toggleDialog() {
    const button = document.getElementById('language-selector-btn');
    const dialog = document.getElementById('language-dialog');
    if (dialog.classList.contains('show')) {
      this.hideDialog();
    } else {
      this.showDialog();
    }
  }

  // Show dialog
  showDialog() {
    const button = document.getElementById('language-selector-btn');
    const dialog = document.getElementById('language-dialog');
    if (!button || !dialog) return;
    button.classList.add('active');
    dialog.classList.add('show');
    dialog.style.display = 'block';
    dialog.style.visibility = 'visible';
    dialog.style.opacity = '1';
    dialog.style.zIndex = '999998';
  }

  // Hide dialog
  hideDialog() {
    const button = document.getElementById('language-selector-btn');
    const dialog = document.getElementById('language-dialog');
    button.classList.remove('active');
    dialog.classList.remove('show');
  }

  // Select a language
  selectLanguage(langCode) {
    if (langCode === this.currentLanguage) {
      this.hideDialog();
      return;
    }
    // Change only the language prefix in the path, preserve the rest
    const currentPath = window.location.pathname;
    const currentSearch = window.location.search;
    const currentHash = window.location.hash;
    const pathSegments = currentPath.split('/');
    const hasLanguage = pathSegments[1] && this.languages[pathSegments[1]];
    let newPath;
    if (langCode === 'en') {
      // Remove language prefix if present
      newPath = hasLanguage ? '/' + pathSegments.slice(2).join('/') : currentPath;
      if (newPath === '' || newPath === '/') newPath = '/';
      else if (newPath.endsWith('/')) newPath = newPath.replace(/\/+/g, '/');
    } else {
      // Add or replace language prefix
      if (hasLanguage) {
        pathSegments[1] = langCode;
        newPath = pathSegments.join('/');
      } else {
        newPath = `/${langCode}${currentPath}`;
      }
    }
    // Clean up double slashes
    newPath = newPath.replace(/\/+/g, '/');
    if (!newPath.startsWith('/')) newPath = '/' + newPath;
    // Update URL and reload
    const newURL = newPath + currentSearch + currentHash;
    window.location.href = newURL;
  }

  // Update current language display
  updateCurrentLanguage() {
    const button = document.getElementById('language-selector-btn');
    if (button) {
      const lang = this.languages[this.currentLanguage];
      button.innerHTML = `
        <span class="flag">${lang?.flag || '🌐'}</span>
        <span class="text">${lang?.native || 'Language'}</span>
        <span class="arrow">▼</span>
      `;
    }
    const options = document.querySelectorAll('.language-option');
    options.forEach(option => {
      option.classList.remove('active');
      if (option.dataset.lang === this.currentLanguage) {
        option.classList.add('active');
      }
    });
  }
}

// Initialize language selector when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    window.languageSelector = new LanguageSelector();
  });
} else {
  window.languageSelector = new LanguageSelector();
}
window.LanguageSelector = LanguageSelector;