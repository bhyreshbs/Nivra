/**
 * Nivra Background Service Worker
 * 
 * INTERACTION WITH CHROME'S BUILT-IN PDF VIEWER:
 * When a user navigates to a PDF file, Chrome normally intercepts it using its internal PDF viewer.
 * By using declarativeNetRequest to redirect the main_frame (or sub_frame) navigation, our extension
 * intercepts the request BEFORE the built-in PDF viewer can load. We redirect the navigation to our
 * own viewer page (viewer/viewer.html), passing the original PDF URL as a query parameter.
 * 
 * ALLOW ACCESS TO FILE URLS:
 * For Nivra to intercept and render local PDFs (e.g., file:///C:/path/to/doc.pdf), the user MUST
 * explicitly enable "Allow access to file URLs" in the extension's settings page (chrome://extensions).
 * Without this permission, Chrome security policies prevent the extension from redirecting or reading
 * file:// URLs, meaning local PDFs will continue to open in Chrome's default viewer.
 */

chrome.runtime.onInstalled.addListener(() => {
  const extensionId = chrome.runtime.id;
  
  // Register a dynamic declarativeNetRequest rule
  chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [1], // Clear the rule if it exists
    addRules: [
      {
        id: 1,
        priority: 1,
        action: {
          type: "redirect",
          redirect: {
            regexSubstitution: `chrome-extension://${extensionId}/viewer/viewer.html?file=\\0`
          }
        },
        condition: {
          regexFilter: "^(https?|file|ftp):\\/\\/.*\\.pdf(?:\\?.*)?(?:#.*)?$",
          resourceTypes: ["main_frame", "sub_frame"]
        }
      }
    ]
  });
});
