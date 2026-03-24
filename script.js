let mainPlayer, secretPlayer;
let viewedPlayer, standbyPlayer; // These will hold the player objects based on their current role
let mainVideoId, secretVideoId;
let playersReady = { main: false, secret: false };
let lastState = -1; // Unstarted

const AD_CHECK_INTERVAL_MS = 100;
const VIEWED_TIME_TRACK_INTERVAL_MS = 50;
const AD_REWIND_THRESHOLD_SECONDS = 1;
const TIME_TRACK_TOLERANCE_SECONDS = 0.05;

// --- Ad detection variables ---
let adCheckInterval = null;
let viewedTimeTrackInterval = null;
let viewedPlayerLastTime = -1;
let standbyPlayerLastTime = -1;
let viewedPlayerStableTime = -1;
let isStandbyPlayerInAdMode = false;
let standbyTimeBeforeAd = -1; // **NEW**: Tracks time before an ad block starts
let standbyAdCount = 0; // **NEW**: Counter for ads in a block
let isSwitching = false; // Prevents overlapping switch commands

function onYouTubeIframeAPIReady() {
    mainPlayer = new YT.Player('main-player', {
        height: '315', width: '560',
        events: { 'onReady': () => onPlayerReady('main'), 'onStateChange': onPlayerStateChange }
    });
    secretPlayer = new YT.Player('secret-player', {
        height: '315', width: '560',
        events: { 'onReady': () => onPlayerReady('secret'), 'onStateChange': onPlayerStateChange }
    });
}

function onPlayerReady(playerName) {
    playersReady[playerName] = true;
    // Assign initial roles once both players are ready
    if (playersReady.main && playersReady.secret) {
        viewedPlayer = mainPlayer;
        standbyPlayer = secretPlayer;
        applyPlayerAudio();
    }
}

// A single state change handler for both players
function onPlayerStateChange(event) {
    if (isSwitching && event.target === viewedPlayer && event.data === YT.PlayerState.PLAYING) {
        console.log("Switch complete. New viewedPlayer is playing.");
        isSwitching = false;
        applyPlayerModes(); // Apply speeds AFTER the new player is confirmed playing.
    }

    if (!isSwitching && event.target === viewedPlayer) {
        syncPlayback(event.data);
    }
}

function syncPlayback(newState) {
    if (newState === YT.PlayerState.PLAYING && lastState !== YT.PlayerState.PLAYING) {
        lastState = YT.PlayerState.PLAYING;
        viewedPlayer.playVideo();
        standbyPlayer.playVideo();
        applyPlayerModes(); // Set speeds
        startViewedTimeTracker();
        startAdChecker();
    } else if (newState === YT.PlayerState.PAUSED && lastState !== YT.PlayerState.PAUSED) {
        lastState = YT.PlayerState.PAUSED;
        viewedPlayer.pauseVideo();
        standbyPlayer.pauseVideo();
        stopViewedTimeTracker();
        stopAdChecker();
    } else if (newState === YT.PlayerState.ENDED) {
        lastState = YT.PlayerState.ENDED;
        stopViewedTimeTracker();
        stopAdChecker();
    }
}

// This function sets the playback rates based on the current roles
function applyPlayerModes() {
    if (!viewedPlayer || !standbyPlayer) return;
    applyPlayerAudio();
    viewedPlayer.setPlaybackRate(1);
    if (!isStandbyPlayerInAdMode) {
        standbyPlayer.setPlaybackRate(2);
    }
}

function applyPlayerAudio() {
    if (!viewedPlayer || !standbyPlayer) return;
    viewedPlayer.unMute();
    standbyPlayer.mute();
}

function startViewedTimeTracker() {
    stopViewedTimeTracker();
    viewedPlayerStableTime = -1;
    updateViewedPlayerStableTime();

    viewedTimeTrackInterval = setInterval(() => {
        if (isSwitching || !viewedPlayer) return;
        if (viewedPlayer.getPlayerState() !== YT.PlayerState.PLAYING) return;
        updateViewedPlayerStableTime();
    }, VIEWED_TIME_TRACK_INTERVAL_MS);
}

function stopViewedTimeTracker() {
    clearInterval(viewedTimeTrackInterval);
    viewedTimeTrackInterval = null;
}

function updateViewedPlayerStableTime() {
    if (!viewedPlayer) return;

    const currentTime = viewedPlayer.getCurrentTime();
    if (!Number.isFinite(currentTime) || currentTime < 0) return;

    if (
        viewedPlayerStableTime < 0 ||
        currentTime >= viewedPlayerStableTime - TIME_TRACK_TOLERANCE_SECONDS
    ) {
        viewedPlayerStableTime = currentTime;
    }
}

function getBestSyncTime() {
    if (viewedPlayerStableTime >= 0 && viewedPlayerLastTime >= 0) {
        return Math.max(viewedPlayerStableTime, viewedPlayerLastTime);
    }
    if (viewedPlayerStableTime >= 0) return viewedPlayerStableTime;
    if (viewedPlayerLastTime >= 0) return viewedPlayerLastTime;
    if (!viewedPlayer) return 0;

    const currentTime = viewedPlayer.getCurrentTime();
    return Number.isFinite(currentTime) && currentTime >= 0 ? currentTime : 0;
}

function startAdChecker() {
    if (adCheckInterval) clearInterval(adCheckInterval);
    viewedPlayerLastTime = -1;
    standbyPlayerLastTime = -1;
    updateViewedPlayerStableTime();

    adCheckInterval = setInterval(() => {
        if (isSwitching || !viewedPlayer || !standbyPlayer) return;

        const viewedTime = viewedPlayer.getCurrentTime();
        const standbyTime = standbyPlayer.getCurrentTime();

        // --- Safety Net Logic ---
        if (standbyTime < viewedTime && !isStandbyPlayerInAdMode) {
            console.warn(`Standby player is behind! Forcing catch-up.`);
            standbyPlayer.seekTo(viewedTime, true);
            standbyPlayer.setPlaybackRate(2);
            if(viewedPlayer.getPlayerState() === YT.PlayerState.PLAYING) {
                standbyPlayer.playVideo();
            }
            standbyPlayerLastTime = -1;
        }

        // --- 1. Check VIEWED player for ads ---
        if (
            viewedPlayerLastTime > 0 &&
            viewedTime < viewedPlayerLastTime &&
            (viewedPlayerLastTime - viewedTime > AD_REWIND_THRESHOLD_SECONDS)
        ) {
            const syncTime = getBestSyncTime();

            // Don't switch if the standby player isn't ready (i.e., it's paused or in an ad itself)
            if (standbyPlayer.getPlayerState() === YT.PlayerState.PAUSED && !isStandbyPlayerInAdMode) {
                console.log(`Ad detected on VIEWED player at ${syncTime.toFixed(2)}s. Switching...`);
                switchPlayerRoles(syncTime);
                return;
            } else {
                console.log("Ad detected on VIEWED player, but standby is not ready. User must watch ad.");
            }
        }
        viewedPlayerLastTime = viewedTime;
        
        // --- 2. Check STANDBY player for ads ---
        if (isStandbyPlayerInAdMode) {
            // **MODIFIED**: Increment ad counter when time jumps forward within an ad block
            if (standbyTime > standbyPlayerLastTime && (standbyTime - standbyPlayerLastTime > 1)) {
                standbyAdCount++;
            }

            const isPreRollAd = standbyTimeBeforeAd < 5;
            const adIsOver = isPreRollAd 
                ? (standbyTime > standbyPlayerLastTime && standbyTime - standbyPlayerLastTime > 1 && standbyAdCount > 0) // Make sure at least one ad was "watched"
                : (standbyTime > standbyTimeBeforeAd);

            if (adIsOver) {
                // --- THIS IS THE TEST LOG YOU REQUESTED ---
                console.log(
                    `%cStandby player finished ${standbyAdCount} ad(s) and is now paused, waiting in standby mode.`,
                    "color: #007bff; font-weight: bold;"
                );
                
                standbyPlayer.pauseVideo();
                isStandbyPlayerInAdMode = false;
                standbyTimeBeforeAd = -1;
                standbyAdCount = 0; // Reset counter
                applyPlayerModes();
            }
        } else if (standbyPlayer.getPlayerState() === YT.PlayerState.PLAYING) {
            if (standbyPlayerLastTime > 0 && standbyTime < standbyPlayerLastTime && (standbyPlayerLastTime - standbyTime > 1)) {
                console.log("Ad detected on STANDBY player. Watching ad block...");
                isStandbyPlayerInAdMode = true;
                standbyTimeBeforeAd = standbyPlayerLastTime;
                standbyAdCount = 0; // Reset counter for the new ad block
                standbyPlayer.setPlaybackRate(1);
            }
        }
        standbyPlayerLastTime = standbyTime;
    }, AD_CHECK_INTERVAL_MS);
}

function stopAdChecker() {
    clearInterval(adCheckInterval);
    adCheckInterval = null;
}

function switchPlayerRoles(syncTime) {
    if (isSwitching) return;
    isSwitching = true;

    // --- THIS IS THE TEST LOG YOU REQUESTED ---
    console.log(
        `%cAd skipped at timestamp ${Math.round(syncTime)}s and videos switched`, 
        "color: #28a745; font-weight: bold; font-size: 14px;"
    );

    // The player that was just running an ad becomes the new standby
    const oldViewedPlayer = viewedPlayer;

    // Swap the roles
    [viewedPlayer, standbyPlayer] = [standbyPlayer, oldViewedPlayer];

    console.log(`Switching roles. New viewed player seeks to ${syncTime}.`);
    
    viewedPlayer.seekTo(syncTime, true);
    viewedPlayer.playVideo();

    document.getElementById('main-player').classList.toggle('hidden');
    document.getElementById('secret-player').classList.toggle('hidden');

    applyPlayerModes();

    viewedPlayerStableTime = syncTime;
    viewedPlayerLastTime = syncTime;
    standbyPlayerLastTime = -1;
    isStandbyPlayerInAdMode = true;
}

document.getElementById('loadVideoBtn').addEventListener('click', function() {
    const videoId = getYouTubeID(document.getElementById('youtubeUrl').value);
    const urlInput = document.getElementById('youtubeUrl');

    if (videoId && playersReady.main && playersReady.secret) {
        mainPlayer.loadVideoById(videoId);
        secretPlayer.loadVideoById(videoId);
        urlInput.style.borderBottomColor = '#28a745';

        document.getElementById('landing-container').classList.add('hidden');
        document.getElementById('player-container').classList.remove('hidden');

    } else {
        urlInput.style.borderBottomColor = '#c00';
    }
});

// **NEW**: Event listener for the Home button
document.getElementById('homeBtn').addEventListener('click', function() {
    // Stop both players
    mainPlayer.stopVideo();
    secretPlayer.stopVideo();

    // Reset state
    lastState = -1;
    viewedPlayerStableTime = -1;
    stopViewedTimeTracker();
    stopAdChecker();

    // Show the landing page and hide the player
    document.getElementById('landing-container').classList.remove('hidden');
    document.getElementById('player-container').classList.add('hidden');

    // Clear the input field for the next use
    const urlInput = document.getElementById('youtubeUrl');
    urlInput.value = '';
    urlInput.style.borderBottomColor = '#bcaaa4'; // Reset border color
});

document.getElementById('loadMainVideoBtn').addEventListener('click', function() {
    mainVideoId = getYouTubeID(document.getElementById('youtubeUrl').value);
    if (mainVideoId && playersReady.main) {
        mainPlayer.loadVideoById(mainVideoId);
        document.getElementById('youtubeUrl').style.border = '1px solid #28a745';
    } else { document.getElementById('youtubeUrl').style.border = '1px solid #c00'; }
});

document.getElementById('loadSecretVideoBtn').addEventListener('click', function() {
    secretVideoId = getYouTubeID(document.getElementById('secretYoutubeUrl').value);
    if (secretVideoId && playersReady.secret) {
        secretPlayer.loadVideoById(secretVideoId);
        document.getElementById('secretYoutubeUrl').style.border = '1px solid #28a745';
    } else { document.getElementById('secretYoutubeUrl').style.border = '1px solid #c00'; }
});

document.getElementById('switchVideoBtn').addEventListener('click', switchPlayerRoles);

function checkSwitchButtonVisibility() {
    if (mainVideoId && secretVideoId) {
        document.getElementById('switchVideoBtn').classList.remove('hidden');
    }
}

function getYouTubeID(url) {
    if (!url) return null;
    const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/;
    const match = url.match(regExp);
    return (match && match[2].length === 11) ? match[2] : null;
}
