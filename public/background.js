// background.js

function initializePopupState() {
    chrome.storage.local.get(["setupComplete"], (result) => {
        if (result.setupComplete) {
            // If setup is complete, bind the popup so it opens automatically on click
            chrome.action.setPopup({ popup: "popup.html" });
        } else {
            // If not complete, ensure no popup is bound so onClicked fires
            chrome.action.setPopup({ popup: "" });
        }
    });
}

// Check state on extension load/reload
chrome.runtime.onInstalled.addListener(initializePopupState);
chrome.runtime.onStartup.addListener(initializePopupState);

// This only fires if the popup is explicitly set to empty ("")
chrome.action.onClicked.addListener((tab) => {
    chrome.storage.local.get(["setupComplete"], (result) => {
        if (!result.setupComplete) {
            chrome.runtime.openOptionsPage();
        } else {
            // Fallback binding if the state fell out of sync during runtime
            chrome.action.setPopup({ popup: "popup.html" });
        }
    });
});
