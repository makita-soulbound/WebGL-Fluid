'use strict';

(() => {
    const maskedTitles = document.querySelectorAll('[data-title-mask]');
    if (!maskedTitles.length) return;

    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const duration = 1800;
    const revealEnd = 160;
    const featherWidth = 18;

    function setDiagonalMask(progress) {
        const opaqueEdge = Math.max(progress - featherWidth, 0);
        const mask = `linear-gradient(
            135deg,
            #000 0%,
            #000 ${opaqueEdge}%,
            transparent ${progress}%
        )`;

        maskedTitles.forEach((title) => {
            title.style.webkitMaskImage = mask;
            title.style.maskImage = mask;
        });
    }

    if (prefersReducedMotion) {
        setDiagonalMask(revealEnd);
        return;
    }

    function easeOutExpo(progress) {
        return progress === 1 ? 1 : 1 - 2 ** (-10 * progress);
    }

    setDiagonalMask(0);

    window.setTimeout(() => {
        const startedAt = performance.now();

        function revealFrame(currentTime) {
            const elapsed = currentTime - startedAt;
            const progress = Math.min(elapsed / duration, 1);
            setDiagonalMask(easeOutExpo(progress) * revealEnd);

            if (progress < 1) {
                requestAnimationFrame(revealFrame);
            }
        }

        requestAnimationFrame(revealFrame);
    }, 300);
})();
