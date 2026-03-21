let mainPlayer, secretPlayer;
let viewedPlayer, standbyPlayer; // These will hold the player objects based on their current role
let mainVideoId, secretVideoId;
let playersReady = { main: false, secret: false };
let lastState = -1; // Unstarted

// --- Ad detection variables ---
let adCheckInterval = null;
let viewedPlayerLastTime = -1;
let standbyPlayerLastTime = -1;
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
        startAdChecker();
    } else if (newState === YT.PlayerState.PAUSED && lastState !== YT.PlayerState.PAUSED) {
        lastState = YT.PlayerState.PAUSED;
        viewedPlayer.pauseVideo();
        standbyPlayer.pauseVideo();
        stopAdChecker();
    } else if (newState === YT.PlayerState.ENDED) {
        lastState = YT.PlayerState.ENDED;
        stopAdChecker();
    }
}

// This function sets the playback rates based on the current roles
function applyPlayerModes() {
    if (!viewedPlayer || !standbyPlayer) return;
    viewedPlayer.setPlaybackRate(1);
    if (!isStandbyPlayerInAdMode) {
        standbyPlayer.setPlaybackRate(2);
    }
}

function startAdChecker() {
    if (adCheckInterval) clearInterval(adCheckInterval);
    viewedPlayerLastTime = -1;
    standbyPlayerLastTime = -1;

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
        if (viewedPlayerLastTime > 0 && viewedTime < viewedPlayerLastTime && (viewedPlayerLastTime - viewedTime > 1)) {
            // Don't switch if the standby player isn't ready (i.e., it's paused or in an ad itself)
            if (standbyPlayer.getPlayerState() === YT.PlayerState.PAUSED && !isStandbyPlayerInAdMode) {
                console.log(`Ad detected on VIEWED player at ${viewedPlayerLastTime}. Switching...`);
                switchPlayerRoles(viewedPlayerLastTime);
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
                    `%cStandby finished watching ${standbyAdCount} ad(s). Pausing successfully.`,
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
    }, 500);
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

    viewedPlayerLastTime = -1;
    standbyPlayerLastTime = -1;
    isStandbyPlayerInAdMode = true;
}

document.getElementById('loadVideoBtn').addEventListener('click', function() {
    const videoId = getYouTubeID(document.getElementById('youtubeUrl').value);
    const urlInput = document.getElementById('youtubeUrl');

    if (videoId && playersReady.main && playersReady.secret) {
        mainPlayer.loadVideoById(videoId);
        secretPlayer.loadVideoById(videoId);
        urlInput.style.border = '1px solid #28a745';
    } else {
        urlInput.style.border = '1px solid #c00';
        document.getElementById('main-player').innerHTML = `<p style="color: red; text-align: center; padding-top: 130px;">Invalid URL or players not ready. Please try again.</p>`;
    }
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