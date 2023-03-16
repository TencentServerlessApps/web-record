document.addEventListener('DOMContentLoaded', function () {
  const startButton = document.getElementById('start');
  startButton.onclick = () => {
    chrome.runtime.sendMessage('START_RECORDING');
  };

  const stopButton = document.getElementById('stop');
  stopButton.onclick = () => {
    chrome.runtime.sendMessage('STOP_RECORDING');
  };
});
