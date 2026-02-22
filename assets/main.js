$(document).ready(function () {
    let currentUser = null;
    let currentEvent = null;

    // Multi-selection region model
    let regions = [];       // Array of { id: number, slots: Set<"date|tod"> }
    let nextRegionId = 0;

    // Drag state
    let isPainting = false;
    let didDrag = false;
    let startSelectionSlot = null;

    // Range mode state
    let isRangeMode = false;
    let rangeStartSlot = null;

    // Tooltip
    let hoverTimeout;

    // Optimistic UI
    let localUnavailCache = null;   // Deep clone of server unavailability_details
    let isSaving = false;

    // ─── TOD ordering helper ───
    const TOD_ORDER = { morning: 0, noon: 1, evening: 2 };

    // ─── Occupied slot detection (overlap prevention) ───
    function getOccupiedSlotKeys() {
        const occupied = new Set();
        for (const region of regions) {
            for (const key of region.slots) {
                occupied.add(key);
            }
        }
        return occupied;
    }

    // ─── Region rendering ───
    function renderRegions() {
        $('.time-slot').removeClass('region-selected').removeAttr('data-region-id');
        $('.region-delete-btn').remove();

        for (const region of regions) {
            let lastKey = null;
            let lastDate = '';
            let lastTodOrder = -1;

            for (const key of region.slots) {
                const [date, tod] = key.split('|');
                const slotEl = $(`.day[data-date="${date}"] .time-slot[data-tod="${tod}"]`);
                if (slotEl.length) {
                    slotEl.addClass('region-selected').attr('data-region-id', region.id);
                }
                // Track the last slot (latest date, then latest tod)
                const todOrder = TOD_ORDER[tod] || 0;
                if (date > lastDate || (date === lastDate && todOrder > lastTodOrder)) {
                    lastDate = date;
                    lastTodOrder = todOrder;
                    lastKey = key;
                }
            }

            // Place X button on the last slot
            if (lastKey) {
                const [date, tod] = lastKey.split('|');
                const lastSlotEl = $(`.day[data-date="${date}"] .time-slot[data-tod="${tod}"]`);
                if (lastSlotEl.length) {
                    lastSlotEl.append(
                        $('<span class="region-delete-btn">&times;</span>')
                            .attr('data-region-id', region.id)
                    );
                }
            }
        }
    }

    // ─── X button handlers ───
    $(document).on('mousedown', '.region-delete-btn', function (e) {
        e.stopPropagation();
        e.preventDefault();
    });

    $(document).on('click', '.region-delete-btn', function (e) {
        e.stopPropagation();
        e.preventDefault();
        const regionId = Number($(this).attr('data-region-id'));
        regions = regions.filter(r => r.id !== regionId);
        renderRegions();
    });

    // ─── Batching algorithm ───
    function computeBatches(allSlots) {
        // Group by date → set of tods
        const byDate = {};
        for (const key of allSlots) {
            const [date, tod] = key.split('|');
            if (!byDate[date]) byDate[date] = [];
            byDate[date].push(tod);
        }

        // Group dates by identical tod-set
        const groups = {};
        for (const [date, tods] of Object.entries(byDate)) {
            const canonicalKey = tods.sort().join(',');
            if (!groups[canonicalKey]) groups[canonicalKey] = [];
            groups[canonicalKey].push(date);
        }

        // Within each group, find contiguous date runs
        const batches = [];
        for (const [todKey, dates] of Object.entries(groups)) {
            dates.sort();
            const tods = todKey.split(',');

            let runStart = dates[0];
            let runEnd = dates[0];

            for (let i = 1; i < dates.length; i++) {
                const expected = nextDay(runEnd);
                if (dates[i] === expected) {
                    runEnd = dates[i];
                } else {
                    batches.push({ start_date: runStart, end_date: runEnd, times_of_day: tods });
                    runStart = dates[i];
                    runEnd = dates[i];
                }
            }
            batches.push({ start_date: runStart, end_date: runEnd, times_of_day: tods });
        }

        return batches;
    }

    function nextDay(dateStr) {
        const [y, m, d] = dateStr.split('-').map(Number);
        const dt = new Date(y, m - 1, d + 1);
        return dt.toISOString().split('T')[0];
    }

    // ─── Optimistic cache helpers ───
    function addUserToCache(slotKeys) {
        if (!localUnavailCache || !currentUser) return;
        for (const key of slotKeys) {
            const [date, tod] = key.split('|');
            if (!localUnavailCache[date]) localUnavailCache[date] = {};
            const existing = localUnavailCache[date][tod] || '';
            const names = existing ? existing.split(',') : [];
            if (!names.includes(currentUser.name)) {
                names.push(currentUser.name);
                localUnavailCache[date][tod] = names.join(',');
            }
        }
    }

    function removeUserFromCache(slotKeys) {
        if (!localUnavailCache || !currentUser) return;
        for (const key of slotKeys) {
            const [date, tod] = key.split('|');
            if (!localUnavailCache[date] || !localUnavailCache[date][tod]) continue;
            const names = localUnavailCache[date][tod].split(',').filter(n => n !== currentUser.name);
            if (names.length > 0) {
                localUnavailCache[date][tod] = names.join(',');
            } else {
                delete localUnavailCache[date][tod];
                if (Object.keys(localUnavailCache[date]).length === 0) {
                    delete localUnavailCache[date];
                }
            }
        }
    }

    function drawCalendarFromCache() {
        if (!currentEvent || !localUnavailCache) return;
        const scrollPos = $(window).scrollTop();
        drawCalendar(currentEvent.event, localUnavailCache);
        renderRegions();
        $(window).scrollTop(scrollPos);
    }

    function deepClone(obj) {
        return JSON.parse(JSON.stringify(obj));
    }

    // ─── Selection range helpers ───
    function getSlotsInRange(startSlot, endSlot) {
        let elementsInRange = new Set();
        if (!startSlot || !endSlot) return elementsInRange;

        const allDays = $('.calendar-grid .day:not(.other-month)');
        let startDayElem = startSlot.closest('.day');
        let endDayElem = endSlot.closest('.day');

        let startDayIndex = allDays.index(startDayElem);
        let endDayIndex = allDays.index(endDayElem);
        let startSlotIndex = startSlot.parent().children('.time-slot').index(startSlot);
        let endSlotIndex = endSlot.parent().children('.time-slot').index(endSlot);

        if (startDayIndex > endDayIndex || (startDayIndex === endDayIndex && startSlotIndex > endSlotIndex)) {
            [startDayIndex, endDayIndex] = [endDayIndex, startDayIndex];
            [startSlotIndex, endSlotIndex] = [endSlotIndex, startSlotIndex];
        }

        for (let d = startDayIndex; d <= endDayIndex; d++) {
            const dayElem = $(allDays[d]);
            const slotsInDay = dayElem.find('.time-slot');
            const loopStart = (d === startDayIndex) ? startSlotIndex : 0;
            const loopEnd = (d === endDayIndex) ? endSlotIndex : slotsInDay.length - 1;

            for (let i = loopStart; i <= loopEnd; i++) {
                elementsInRange.add(slotsInDay[i]);
            }
        }
        return elementsInRange;
    }

    function slotKey(el) {
        const $el = $(el);
        return `${$el.closest('.day').data('date')}|${$el.data('tod')}`;
    }

    function filterOccupied(elements) {
        const occupied = getOccupiedSlotKeys();
        const filtered = new Set();
        elements.forEach(el => {
            if (!occupied.has(slotKey(el))) {
                filtered.add(el);
            }
        });
        return filtered;
    }

    // ─── Drag visual update ───
    function updatePendingSelection(endSlot) {
        const rawRange = getSlotsInRange(startSelectionSlot, endSlot);
        const filtered = filterOccupied(rawRange);

        $('.calendar-grid .time-slot').each(function () {
            if (filtered.has(this)) {
                if (!$(this).hasClass('pending-selected')) {
                    $(this).addClass('pending-selected');
                }
            } else {
                $(this).removeClass('pending-selected');
            }
        });
    }

    // ─── Finalize drag into a region ───
    function finalizeDragAsRegion() {
        const slots = new Set();
        $('.time-slot.pending-selected').each(function () {
            slots.add(slotKey(this));
        });
        $('.time-slot').removeClass('pending-selected');

        if (slots.size > 0) {
            regions.push({ id: nextRegionId++, slots });
            renderRegions();
        }
    }

    // ─── Single click (non-range) ───
    function handleNonRangeClick(clickedSlot) {
        const key = slotKey(clickedSlot[0]);

        // Check if slot belongs to an existing region
        for (let i = 0; i < regions.length; i++) {
            if (regions[i].slots.has(key)) {
                regions[i].slots.delete(key);
                if (regions[i].slots.size === 0) {
                    regions.splice(i, 1);
                }
                renderRegions();
                return;
            }
        }

        // Otherwise, create a new single-slot region (if not occupied)
        const occupied = getOccupiedSlotKeys();
        if (!occupied.has(key)) {
            regions.push({ id: nextRegionId++, slots: new Set([key]) });
            renderRegions();
        }
    }

    // ─── Range mode click handling ───
    function handleRangeClick(clickedSlot) {
        if (!rangeStartSlot) {
            // First click: set start
            $('.time-slot').removeClass('pending-selected');
            rangeStartSlot = clickedSlot;
            startSelectionSlot = clickedSlot;
            $('.time-slot.range-start').removeClass('range-start');
            rangeStartSlot.addClass('range-start');
        } else {
            // Second click: create region
            const rawRange = getSlotsInRange(rangeStartSlot, clickedSlot);
            const filtered = filterOccupied(rawRange);
            const slots = new Set();
            filtered.forEach(el => slots.add(slotKey(el)));

            if (slots.size > 0) {
                regions.push({ id: nextRegionId++, slots });

                // Staggered animation
                const elements = $(Array.from(filtered));
                elements.each(function (index) {
                    const slot = $(this);
                    setTimeout(() => {
                        slot.css('transition-delay', `${index * 15}ms`);
                        slot.addClass('region-selected');
                    }, 0);
                });
                setTimeout(() => {
                    elements.css('transition-delay', '');
                    renderRegions();
                }, filtered.size * 15 + 200);
            }

            $('.time-slot.range-start').removeClass('range-start');
            rangeStartSlot = null;
            startSelectionSlot = null;
        }
    }

    // ─── Mouse event handlers ───
    $(document).on('mousedown', '.time-slot', function (e) {
        if ($(this).closest('.day').hasClass('other-month') || isRangeMode) return;
        e.preventDefault();
        isPainting = true;
        didDrag = false;
        startSelectionSlot = $(this);
        // Clear only pending drag visual, not committed regions
        $('.time-slot').removeClass('pending-selected');
    });

    $(document).on('mouseenter', '.time-slot', function () {
        if (isPainting && !isRangeMode) {
            if (!didDrag) didDrag = true;
            updatePendingSelection($(this));
        }
    });

    $(document).on('mouseup', function (e) {
        if (isPainting) {
            isPainting = false;
            const targetSlot = $(e.target).closest('.time-slot');
            if (targetSlot.length > 0 && !didDrag) {
                handleNonRangeClick(targetSlot);
            } else if (didDrag) {
                finalizeDragAsRegion();
            }
        }
    });

    $(document).on('click', '.time-slot', function (e) {
        if (isRangeMode && !isPainting) {
            handleRangeClick($(this));
        }
    });

    // ─── Tooltip ───
    function showTooltip(element, namesString) {
        $('.name-tooltip').remove();
        const names = namesString.split(',');
        let listItems = '';
        names.forEach(name => {
            listItems += `<li>${name.trim()}</li>`;
        });
        const tooltip = $(`<div class="name-tooltip"><ul>${listItems}</ul></div>`);
        $('body').append(tooltip);

        const pos = element.offset();
        const elementHeight = element.outerHeight();
        tooltip.css({
            top: pos.top + elementHeight + 5,
            left: pos.left,
        });
    }

    $(document).on('mouseenter', '.time-slot', function () {
        const names = $(this).data('names');
        if (names) {
            const element = $(this);
            hoverTimeout = setTimeout(() => {
                showTooltip(element, names);
            }, 1000);
        }
    });

    $(document).on('mouseleave', '.time-slot', function () {
        clearTimeout(hoverTimeout);
        $('.name-tooltip').remove();
    });

    // ─── User auth ───
    function initializeUser() {
        const savedUserJSON = localStorage.getItem('sarbuleUser');
        if (savedUserJSON) {
            try {
                currentUser = JSON.parse(savedUserJSON);
                if (currentUser && currentUser.id && currentUser.name) {
                    showMainView();
                } else {
                    logout();
                }
            } catch (e) {
                logout();
            }
        } else {
            $('#user-prompt').removeClass('hidden');
        }
    }

    function logout() {
        localStorage.removeItem('sarbuleUser');
        currentUser = null;
        location.reload();
    }

    initializeUser();

    $('#logout-btn').on('click', logout);

    function loginUser(user) {
        currentUser = user;
        localStorage.setItem('sarbuleUser', JSON.stringify(user));
        showMainView();
    }

    $('#submit-name-btn').on('click', function () {
        const name = $('#user-name-input').val().trim();
        if (!name) return;

        $.ajax({
            url: '/api/users/login',
            type: 'POST',
            contentType: 'application/json',
            data: JSON.stringify({ name: name }),
            success: function (response) {
                if (response.status === 'Created') {
                    loginUser(response.user);
                } else if (response.status === 'Exists') {
                    if (confirm(`juz ktos taki jest (${response.user.name}), czy to ty??`)) {
                        loginUser(response.user);
                    } else {
                        alert('Wybierz inne imie.');
                    }
                }
            },
            error: function () {
                alert('Wystapil blad podczas logowania. Sprobuj ponownie.');
            }
        });
    });

    // ─── Event views ───
    function showMainView() {
        $('#user-prompt').addClass('hidden');
        $('#calendar-view').addClass('hidden');
        $('#back-to-list-btn').addClass('hidden');
        $('#welcome-user-name').text(currentUser.name);
        $('#main-view').removeClass('hidden');
        loadEventList();
    }

    function loadEventList() {
        $.get('/api/events', function (events) {
            const list = $('#event-list').empty();
            events.forEach(event => list.append(`<li><a href="#" class="event-link" data-id="${event.public_id}">${event.name}</a></li>`));
        });
    }

    function showEventCalendar(publicId) {
        $.get(`/api/events/${publicId}`, function (response) {
            currentEvent = response;
            localUnavailCache = deepClone(response.unavailability_details);
            regions = [];
            nextRegionId = 0;
            $('#main-view').addClass('hidden');
            $('#calendar-view').removeClass('hidden');
            $('#back-to-list-btn').removeClass('hidden');
            $('#event-title').text(response.event.name);
            drawCalendar(response.event, localUnavailCache);
        });
    }

    $(document).on('click', '.event-link', function (e) {
        e.preventDefault();
        showEventCalendar($(this).data('id'));
    });

    $('#back-to-list-btn').on('click', showMainView);

    // ─── Calendar rendering ───
    function drawCalendar(event, details) {
        const earliest = new Date(event.earliest);
        const latest = new Date(event.latest);
        const grid = $('#calendar-grid').empty();
        const dayNames = ['ndz', 'pon', 'wt', 'śr', 'czw', 'pt', 'sob'];

        let currentDate = new Date(earliest);
        let currentMonth = -1;

        while (currentDate <= latest) {
            if (currentDate.getMonth() !== currentMonth) {
                let cellCounter = grid.children('.day').length;
                if (currentMonth !== -1) {
                    while (cellCounter % 7 !== 0) {
                        grid.append('<div class="day other-month"></div>');
                        cellCounter++;
                    }
                }
                currentMonth = currentDate.getMonth();

                const monthName = currentDate.toLocaleString('pl-PL', { month: 'long', year: 'numeric' });
                const capitalizedMonth = monthName.charAt(0).toUpperCase() + monthName.slice(1);
                const separator = $(`<div class="month-separator">${capitalizedMonth}</div>`);
                grid.append(separator);

                let dayOfWeek = currentDate.getDay();
                if (dayOfWeek === 0) dayOfWeek = 7;
                for (let i = 1; i < dayOfWeek; i++) {
                    grid.append('<div class="day other-month"></div>');
                }
            }
            const dayStr = currentDate.toISOString().split('T')[0];
            const dayCell = $(`<div class="day" data-date="${dayStr}"></div>`);

            const dayName = dayNames[currentDate.getDay()];
            const dayNumber = currentDate.getDate();
            const headerHtml = `<div class="day-header">
                                  <span class="day-name">${dayName}</span>
                                  <span class="day-number">${dayNumber}</span>
                                </div>`;
            dayCell.append(headerHtml);

            const dayDetails = details[dayStr] || {};

            ['morning', 'noon', 'evening'].forEach(tod => {
                const namesString = dayDetails[tod] || '';
                const names = namesString ? namesString.split(',') : [];
                const count = names.length;

                const slot = $(`<div class="time-slot ${tod}" data-tod="${tod}"></div>`);
                if (namesString) {
                    slot.data('names', namesString);
                }

                if (count > 0) {
                    slot.addClass(`unavailable-${Math.min(count, 5)}`);
                    slot.text(count);
                }
                dayCell.append(slot);
            });
            grid.append(dayCell);
            currentDate.setDate(currentDate.getDate() + 1);
        }

        let finalCellCounter = grid.children('.day').length;
        while (finalCellCounter > 0 && finalCellCounter % 7 !== 0) {
            grid.append('<div class="day other-month"></div>');
            finalCellCounter++;
        }
    }

    // ─── API error handling ───
    function handleApiError(jqXHR) {
        if (jqXHR && jqXHR.status === 404 && jqXHR.responseText && jqXHR.responseText.includes("Uzytkownik")) {
            alert('Twoje dane logowania sa nieaktualne. Zostaniesz automatycznie wylogowany.');
            logout();
        } else {
            alert('Wystapil blad operacji.');
        }
    }

    // ─── Optimistic save / remove ───
    function sendAvailabilityRequest(httpMethod) {
        if (regions.length === 0 || isSaving) return;

        isSaving = true;
        $('#save-availability-btn').addClass('saving');
        $('#remove-availability-btn').addClass('saving');

        // Collect all slots from all regions
        const allSlots = new Set();
        for (const region of regions) {
            for (const key of region.slots) {
                allSlots.add(key);
            }
        }

        // Optimistic update
        if (httpMethod === 'POST') {
            addUserToCache(allSlots);
        } else {
            removeUserFromCache(allSlots);
        }

        // Clear regions and redraw immediately
        regions = [];
        nextRegionId = 0;
        drawCalendarFromCache();

        // Batch and send requests
        const batches = computeBatches(allSlots);
        const promises = batches.map(batch => {
            return $.ajax({
                url: `/api/events/${currentEvent.event.public_id}/availability`,
                type: httpMethod,
                contentType: 'application/json',
                data: JSON.stringify({
                    user_id: currentUser.id,
                    start_date: batch.start_date,
                    end_date: batch.end_date,
                    times_of_day: batch.times_of_day
                })
            });
        });

        Promise.all(promises)
            .then(() => {
                isSaving = false;
                $('#save-availability-btn').removeClass('saving');
                $('#remove-availability-btn').removeClass('saving');
                // Background refresh to sync other users' changes
                $.get(`/api/events/${currentEvent.event.public_id}`, function (response) {
                    currentEvent = response;
                    localUnavailCache = deepClone(response.unavailability_details);
                    drawCalendarFromCache();
                });
            })
            .catch((err) => {
                isSaving = false;
                $('#save-availability-btn').removeClass('saving');
                $('#remove-availability-btn').removeClass('saving');
                handleApiError(err);
                // Rollback: re-fetch from server
                showEventCalendar(currentEvent.event.public_id);
            });
    }

    // ─── Button handlers ───
    $('#save-availability-btn').on('click', function () {
        sendAvailabilityRequest('POST');
    });

    $('#remove-availability-btn').on('click', function () {
        sendAvailabilityRequest('DELETE');
    });

    $('#clear-selection-btn').on('click', function () {
        regions = [];
        nextRegionId = 0;
        $('.time-slot').removeClass('pending-selected');
        renderRegions();
    });

    $('#range-mode-btn').on('click', function () {
        isRangeMode = !isRangeMode;
        $(this).toggleClass('active', isRangeMode);
        $('.time-slot.range-start').removeClass('range-start');
        rangeStartSlot = null;
    });

    $('#clear-all-btn').on('click', function () {
        if (!currentUser || !currentEvent) return;
        if (!confirm('czy na pewno chcesz usunac wszystkie swoje zaznaczenia dla tego wydarzenia?')) return;

        regions = [];
        nextRegionId = 0;

        $.ajax({
            url: `/api/events/${currentEvent.event.public_id}/my-availability`,
            type: 'DELETE',
            contentType: 'application/json',
            data: JSON.stringify({ user_id: currentUser.id }),
        })
        .then(() => {
            showEventCalendar(currentEvent.event.public_id);
        })
        .catch(handleApiError);
    });
});
