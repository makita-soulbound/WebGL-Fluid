'use strict';

(() => {
    const opening = document.querySelector('.opening');
    const skipButton = document.querySelector('.opening__skip');
    const forceFullMotion = new URLSearchParams(window.location.search).get('motion') === 'full';
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
        && !forceFullMotion;
    const timers = [];

    function completeAnimation() {
        opening.classList.add('is-complete');
    }

    function skipAnimation() {
        timers.forEach(window.clearTimeout);
        opening.classList.add('is-tracing', 'is-skipped');
        completeAnimation();
    }

    if (reducedMotion) {
        opening.classList.add('is-tracing', 'is-skipped', 'is-complete');
    } else {
        timers.push(window.setTimeout(() => {
            opening.classList.add('is-tracing');
        }, 180));
        timers.push(window.setTimeout(completeAnimation, 1700));
    }

    skipButton.addEventListener('click', skipAnimation);
})();
