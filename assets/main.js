$(document).ready(function() {
    let currentUser = null;
    let currentEvent = null;

    // selections - each one is { id, slots: Set<"date|tod"> }
    let regions = [];
    let nextRegionId = 0;

    let isPainting = false;
    let didDrag = false;
    let startSelectionSlot = null;
    let isRangeMode = false;
    let rangeStartSlot = null;
    let hoverTimeout;

    // local copy of unavailability data for optimistic updates
    let localUnavailCache = null;
    let isSaving = false;

    const todOrder = { morning: 0, noon: 1, evening: 2 };

    // collect all slot keys that are already in some region
    function getOccupiedKeys() {
        const keys = new Set();
        for (const r of regions)
            for (const k of r.slots)
                keys.add(k);
        return keys;
    }

    // redraw green highlights + x buttons for all regions
    function renderRegions() {
        $('.time-slot').removeClass('region-selected').removeAttr('data-region-id');
        $('.region-delete-btn').remove();

        for (const region of regions) {
            let lastKey = null;
            let lastDate = '';
            let lastTod = -1;

            for (const key of region.slots) {
                const [date, tod] = key.split('|');
                const el = $(`.day[data-date="${date}"] .time-slot[data-tod="${tod}"]`);
                if (el.length) el.addClass('region-selected').attr('data-region-id', region.id);

                const to = todOrder[tod] || 0;
                if (date > lastDate || (date === lastDate && to > lastTod)) {
                    lastDate = date;
                    lastTod = to;
                    lastKey = key;
                }
            }

            if (lastKey) {
                const [date, tod] = lastKey.split('|');
                const el = $(`.day[data-date="${date}"] .time-slot[data-tod="${tod}"]`);
                if (el.length)
                    el.append($('<span class="region-delete-btn">&times;</span>').attr('data-region-id', region.id));
            }
        }
    }

    // x button - stop event from reaching the slot handlers
    $(document).on('mousedown', '.region-delete-btn', function(e) {
        e.stopPropagation();
        e.preventDefault();
    });
    $(document).on('click', '.region-delete-btn', function(e) {
        e.stopPropagation();
        e.preventDefault();
        const id = Number($(this).attr('data-region-id'));
        regions = regions.filter(r => r.id !== id);
        renderRegions();
    });

    // groups selected slots into minimal api requests
    // merges consecutive days with same time-of-day sets
    function computeBatches(allSlots) {
        const byDate = {};
        for (const key of allSlots) {
            const [date, tod] = key.split('|');
            if (!byDate[date]) byDate[date] = [];
            byDate[date].push(tod);
        }

        // group dates that share the exact same tod set
        const groups = {};
        for (const [date, tods] of Object.entries(byDate)) {
            const k = tods.sort().join(',');
            if (!groups[k]) groups[k] = [];
            groups[k].push(date);
        }

        // merge consecutive days into single requests
        const batches = [];
        for (const [todKey, dates] of Object.entries(groups)) {
            dates.sort();
            const tods = todKey.split(',');
            let start = dates[0], end = dates[0];

            for (let i = 1; i < dates.length; i++) {
                if (dates[i] === nextDay(end)) {
                    end = dates[i];
                } else {
                    batches.push({ start_date: start, end_date: end, times_of_day: tods });
                    start = dates[i];
                    end = dates[i];
                }
            }
            batches.push({ start_date: start, end_date: end, times_of_day: tods });
        }
        return batches;
    }

    function nextDay(dateStr) {
        const [y, m, d] = dateStr.split('-').map(Number);
        return new Date(y, m - 1, d + 1).toISOString().split('T')[0];
    }

    // optimistic cache manipulation
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
                if (Object.keys(localUnavailCache[date]).length === 0)
                    delete localUnavailCache[date];
            }
        }
    }

    function drawCalendarFromCache() {
        if (!currentEvent || !localUnavailCache) return;
        const scroll = $(window).scrollTop();
        drawCalendar(currentEvent.event, localUnavailCache);
        renderRegions();
        $(window).scrollTop(scroll);
    }

    function deepClone(obj) {
        return JSON.parse(JSON.stringify(obj));
    }

    // get all slot dom elements between two slots
    function getSlotsInRange(startSlot, endSlot) {
        let elements = new Set();
        if (!startSlot || !endSlot) return elements;

        const allDays = $('.calendar-grid .day:not(.other-month)');
        let si = allDays.index(startSlot.closest('.day'));
        let ei = allDays.index(endSlot.closest('.day'));
        let ss = startSlot.parent().children('.time-slot').index(startSlot);
        let es = endSlot.parent().children('.time-slot').index(endSlot);

        if (si > ei || (si === ei && ss > es)) {
            [si, ei] = [ei, si];
            [ss, es] = [es, ss];
        }

        for (let d = si; d <= ei; d++) {
            const slots = $(allDays[d]).find('.time-slot');
            const from = (d === si) ? ss : 0;
            const to = (d === ei) ? es : slots.length - 1;
            for (let i = from; i <= to; i++) elements.add(slots[i]);
        }
        return elements;
    }

    function slotKey(el) {
        const $el = $(el);
        return `${$el.closest('.day').data('date')}|${$el.data('tod')}`;
    }

    // filter out slots already claimed by another region
    function filterOccupied(elements) {
        const occupied = getOccupiedKeys();
        const out = new Set();
        elements.forEach(el => {
            if (!occupied.has(slotKey(el))) out.add(el);
        });
        return out;
    }

    // live preview while dragging
    function updatePendingSelection(endSlot) {
        const filtered = filterOccupied(getSlotsInRange(startSelectionSlot, endSlot));
        $('.calendar-grid .time-slot').each(function() {
            if (filtered.has(this)) {
                if (!$(this).hasClass('pending-selected')) $(this).addClass('pending-selected');
            } else {
                $(this).removeClass('pending-selected');
            }
        });
    }

    // turn current drag into a committed region
    function finalizeDrag() {
        const slots = new Set();
        $('.time-slot.pending-selected').each(function() { slots.add(slotKey(this)); });
        $('.time-slot').removeClass('pending-selected');
        if (slots.size > 0) {
            regions.push({ id: nextRegionId++, slots });
            renderRegions();
        }
    }

    // single click toggles a slot in/out of regions
    function handleClick(clickedSlot) {
        const key = slotKey(clickedSlot[0]);

        // if it's already in a region, remove it
        for (let i = 0; i < regions.length; i++) {
            if (regions[i].slots.has(key)) {
                regions[i].slots.delete(key);
                if (regions[i].slots.size === 0) regions.splice(i, 1);
                renderRegions();
                return;
            }
        }

        // otherwise make a new single-slot region
        if (!getOccupiedKeys().has(key)) {
            regions.push({ id: nextRegionId++, slots: new Set([key]) });
            renderRegions();
        }
    }

    // range mode: first click sets start, second click creates region
    function handleRangeClick(clickedSlot) {
        if (!rangeStartSlot) {
            $('.time-slot').removeClass('pending-selected');
            rangeStartSlot = clickedSlot;
            startSelectionSlot = clickedSlot;
            $('.time-slot.range-start').removeClass('range-start');
            rangeStartSlot.addClass('range-start');
        } else {
            const filtered = filterOccupied(getSlotsInRange(rangeStartSlot, clickedSlot));
            const slots = new Set();
            filtered.forEach(el => slots.add(slotKey(el)));

            if (slots.size > 0) {
                regions.push({ id: nextRegionId++, slots });
                // little staggered animation
                const els = $(Array.from(filtered));
                els.each(function(i) {
                    const s = $(this);
                    setTimeout(() => {
                        s.css('transition-delay', `${i * 15}ms`);
                        s.addClass('region-selected');
                    }, 0);
                });
                setTimeout(() => {
                    els.css('transition-delay', '');
                    renderRegions();
                }, filtered.size * 15 + 200);
            }

            $('.time-slot.range-start').removeClass('range-start');
            rangeStartSlot = null;
            startSelectionSlot = null;
        }
    }

    // mouse handlers
    $(document).on('mousedown', '.time-slot', function(e) {
        if ($(this).closest('.day').hasClass('other-month') || isRangeMode) return;
        e.preventDefault();
        isPainting = true;
        didDrag = false;
        startSelectionSlot = $(this);
        $('.time-slot').removeClass('pending-selected');
    });

    $(document).on('mouseenter', '.time-slot', function() {
        if (isPainting && !isRangeMode) {
            if (!didDrag) didDrag = true;
            updatePendingSelection($(this));
        }
    });

    $(document).on('mouseup', function(e) {
        if (isPainting) {
            isPainting = false;
            const target = $(e.target).closest('.time-slot');
            if (target.length > 0 && !didDrag) handleClick(target);
            else if (didDrag) finalizeDrag();
        }
    });

    $(document).on('click', '.time-slot', function() {
        if (isRangeMode && !isPainting) handleRangeClick($(this));
    });

    // tooltip on hover showing who's unavailable
    function showTooltip(element, namesString) {
        $('.name-tooltip').remove();
        const items = namesString.split(',').map(n => `<li>${n.trim()}</li>`).join('');
        const tooltip = $(`<div class="name-tooltip"><ul>${items}</ul></div>`);
        $('body').append(tooltip);
        const pos = element.offset();
        tooltip.css({ top: pos.top + element.outerHeight() + 5, left: pos.left });
    }

    $(document).on('mouseenter', '.time-slot', function() {
        const names = $(this).data('names');
        if (names) {
            const el = $(this);
            hoverTimeout = setTimeout(() => showTooltip(el, names), 1000);
        }
    });

    $(document).on('mouseleave', '.time-slot', function() {
        clearTimeout(hoverTimeout);
        $('.name-tooltip').remove();
    });

    // auth
    function initializeUser() {
        const saved = localStorage.getItem('sarbuleUser');
        if (saved) {
            try {
                currentUser = JSON.parse(saved);
                if (currentUser && currentUser.id && currentUser.name) showMainView();
                else logout();
            } catch(e) { logout(); }
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

    $('#submit-name-btn').on('click', function() {
        const name = $('#user-name-input').val().trim();
        if (!name) return;
        $.ajax({
            url: '/api/users/login',
            type: 'POST',
            contentType: 'application/json',
            data: JSON.stringify({ name }),
            success: function(response) {
                if (response.status === 'Created') {
                    loginUser(response.user);
                } else if (response.status === 'Exists') {
                    if (confirm(`juz ktos taki jest (${response.user.name}), czy to ty??`))
                        loginUser(response.user);
                    else
                        alert('Wybierz inne imie.');
                }
            },
            error: function() { alert('Wystapil blad podczas logowania. Sprobuj ponownie.'); }
        });
    });

    // views
    function showMainView() {
        $('#user-prompt').addClass('hidden');
        $('#calendar-view').addClass('hidden');
        $('#back-to-list-btn').addClass('hidden');
        $('#welcome-user-name').text(currentUser.name);
        $('#main-view').removeClass('hidden');
        loadEventList();
    }

    function loadEventList() {
        $.get('/api/events', function(events) {
            const list = $('#event-list').empty();
            events.forEach(ev => list.append(`<li><a href="#" class="event-link" data-id="${ev.public_id}">${ev.name}</a></li>`));
        });
    }

    function showEventCalendar(publicId) {
        $.get(`/api/events/${publicId}`, function(response) {
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

    $(document).on('click', '.event-link', function(e) {
        e.preventDefault();
        showEventCalendar($(this).data('id'));
    });
    $('#back-to-list-btn').on('click', showMainView);

    // calendar grid
    function drawCalendar(event, details) {
        const earliest = new Date(event.earliest);
        const latest = new Date(event.latest);
        const grid = $('#calendar-grid').empty();
        const dayNames = ['ndz', 'pon', 'wt', 'śr', 'czw', 'pt', 'sob'];
        let currentDate = new Date(earliest);
        let currentMonth = -1;

        while (currentDate <= latest) {
            if (currentDate.getMonth() !== currentMonth) {
                let cells = grid.children('.day').length;
                if (currentMonth !== -1) {
                    while (cells % 7 !== 0) { grid.append('<div class="day other-month"></div>'); cells++; }
                }
                currentMonth = currentDate.getMonth();
                const monthName = currentDate.toLocaleString('pl-PL', { month: 'long', year: 'numeric' });
                grid.append($(`<div class="month-separator">${monthName.charAt(0).toUpperCase() + monthName.slice(1)}</div>`));
                let dow = currentDate.getDay();
                if (dow === 0) dow = 7;
                for (let i = 1; i < dow; i++) grid.append('<div class="day other-month"></div>');
            }

            const dayStr = currentDate.toISOString().split('T')[0];
            const dayCell = $(`<div class="day" data-date="${dayStr}"></div>`);
            const dayName = dayNames[currentDate.getDay()];
            const dayNumber = currentDate.getDate();
            dayCell.append(`<div class="day-header"><span class="day-name">${dayName}</span><span class="day-number">${dayNumber}</span></div>`);

            const dayDetails = details[dayStr] || {};
            ['morning', 'noon', 'evening'].forEach(tod => {
                const namesString = dayDetails[tod] || '';
                const names = namesString ? namesString.split(',') : [];
                const slot = $(`<div class="time-slot ${tod}" data-tod="${tod}"></div>`);
                if (namesString) slot.data('names', namesString);
                if (names.length > 0) {
                    slot.addClass(`unavailable-${Math.min(names.length, 5)}`);
                    slot.text(names.length);
                }
                dayCell.append(slot);
            });

            grid.append(dayCell);
            currentDate.setDate(currentDate.getDate() + 1);
        }

        let finalCells = grid.children('.day').length;
        while (finalCells > 0 && finalCells % 7 !== 0) {
            grid.append('<div class="day other-month"></div>');
            finalCells++;
        }
    }

    function handleApiError(jqXHR) {
        if (jqXHR && jqXHR.status === 404 && jqXHR.responseText && jqXHR.responseText.includes('Uzytkownik')) {
            alert('Twoje dane logowania sa nieaktualne. Zostaniesz automatycznie wylogowany.');
            logout();
        } else {
            alert('Wystapil blad operacji.');
        }
    }

    // save or remove selected slots, with optimistic ui
    function sendAvailabilityRequest(method) {
        if (regions.length === 0 || isSaving) return;

        isSaving = true;
        $('#save-availability-btn').addClass('saving');
        $('#remove-availability-btn').addClass('saving');

        const allSlots = new Set();
        for (const r of regions) for (const k of r.slots) allSlots.add(k);

        if (method === 'POST') addUserToCache(allSlots);
        else removeUserFromCache(allSlots);

        regions = [];
        nextRegionId = 0;
        drawCalendarFromCache();

        const batches = computeBatches(allSlots);
        const promises = batches.map(b => $.ajax({
            url: `/api/events/${currentEvent.event.public_id}/availability`,
            type: method,
            contentType: 'application/json',
            data: JSON.stringify({
                user_id: currentUser.id,
                start_date: b.start_date,
                end_date: b.end_date,
                times_of_day: b.times_of_day
            })
        }));

        Promise.all(promises)
            .then(() => {
                isSaving = false;
                $('#save-availability-btn').removeClass('saving');
                $('#remove-availability-btn').removeClass('saving');
                // sync with server in background (picks up other users' changes)
                $.get(`/api/events/${currentEvent.event.public_id}`, function(resp) {
                    currentEvent = resp;
                    localUnavailCache = deepClone(resp.unavailability_details);
                    drawCalendarFromCache();
                });
            })
            .catch(err => {
                isSaving = false;
                $('#save-availability-btn').removeClass('saving');
                $('#remove-availability-btn').removeClass('saving');
                handleApiError(err);
                showEventCalendar(currentEvent.event.public_id);
            });
    }

    // buttons
    $('#save-availability-btn').on('click', function() { sendAvailabilityRequest('POST'); });
    $('#remove-availability-btn').on('click', function() { sendAvailabilityRequest('DELETE'); });

    $('#clear-selection-btn').on('click', function() {
        regions = [];
        nextRegionId = 0;
        $('.time-slot').removeClass('pending-selected');
        renderRegions();
    });

    $('#range-mode-btn').on('click', function() {
        isRangeMode = !isRangeMode;
        $(this).toggleClass('active', isRangeMode);
        $('.time-slot.range-start').removeClass('range-start');
        rangeStartSlot = null;
    });

    $('#clear-all-btn').on('click', function() {
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
        .then(() => showEventCalendar(currentEvent.event.public_id))
        .catch(handleApiError);
    });
});
