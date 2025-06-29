$(document).ready(function () {
    let currentUser = null;
    let currentEvent = null;
    let selectedSlots = new Set();
    
    let isPainting = false;
    let didDrag = false;
    let startSelectionSlot = null;
    
    let isRangeMode = false;
    let rangeStartSlot = null;
    
    let hoverTimeout;

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

    $('#submit-name-btn').on('click', function() {
        const name = $('#user-name-input').val().trim();
        if (!name) return;
        
        $.ajax({
            url: '/api/users/login',
            type: 'POST',
            contentType: 'application/json',
            data: JSON.stringify({ name: name }),
            success: function(response) {
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
            error: function() {
                alert('Wystapil blad podczas logowania. Sprobuj ponownie.');
            }
        });
    });
    
    function applyStaggeredAnimation(elements) {
        elements.each(function(index) {
            const slot = $(this);
            setTimeout(() => {
                slot.css('transition-delay', `${index * 15}ms`);
                slot.addClass('selected');
            }, 0);
        });

        setTimeout(() => {
            elements.css('transition-delay', '');
        }, elements.length * 15 + 200);
    }
    
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

    function updateMixedSelection(endSlot) {
        const newSelectionElements = getSlotsInRange(startSelectionSlot, endSlot);
        
        $('.calendar-grid .time-slot').each(function() {
            if (newSelectionElements.has(this)) {
                if (!$(this).hasClass('selected')) {
                    $(this).addClass('selected');
                }
            } else {
                if ($(this).hasClass('selected')) {
                    $(this).removeClass('selected');
                }
            }
        });
    }

    function finalizeDragSelection() {
        selectedSlots.clear();
        $('.time-slot.selected').each(function() {
            const key = `${$(this).closest('.day').data('date')}|${$(this).data('tod')}`;
            selectedSlots.add(key);
        });
    }
    
    function handleSingleClick(clickedSlot) {
        if (isRangeMode) {
            if (!rangeStartSlot) {
                $('.time-slot.selected').removeClass('selected');
                selectedSlots.clear();
                rangeStartSlot = clickedSlot;
                startSelectionSlot = clickedSlot;
                $('.time-slot.range-start').removeClass('range-start');
                rangeStartSlot.addClass('range-start');
            } else {
                const elementsToSelect = getSlotsInRange(rangeStartSlot, clickedSlot);
                $('.time-slot.selected').removeClass('selected');
                
                elementsToSelect.forEach(el => {
                    const key = `${$(el).closest('.day').data('date')}|${$(el).data('tod')}`;
                    selectedSlots.add(key);
                });
                
                applyStaggeredAnimation($(Array.from(elementsToSelect)));
                
                $('.time-slot.range-start').removeClass('range-start');
                rangeStartSlot = null;
                startSelectionSlot = null;
            }
        } else {
            const key = `${clickedSlot.closest('.day').data('date')}|${clickedSlot.data('tod')}`;
            if(selectedSlots.has(key)) {
                selectedSlots.delete(key);
                clickedSlot.removeClass('selected');
            } else {
                selectedSlots.add(key);
                clickedSlot.addClass('selected');
            }
        }
    }
    
    $(document).on('mousedown', '.time-slot', function(e) {
        if ($(this).closest('.day').hasClass('other-month') || isRangeMode) return;
        e.preventDefault();
        isPainting = true;
        didDrag = false;
        startSelectionSlot = $(this);
        $('.time-slot.selected').removeClass('selected');
        selectedSlots.clear();
    });

    $(document).on('mouseenter', '.time-slot', function() {
        if(isPainting && !isRangeMode) {
            if (!didDrag) {
                didDrag = true;
            }
            updateMixedSelection($(this));
        }
    });
    
    $(document).on('mouseup', function(e) {
        if (isPainting) {
            isPainting = false;
            const targetSlot = $(e.target).closest('.time-slot');
            if (targetSlot.length > 0 && !didDrag) {
                 handleSingleClick(targetSlot);
            } else if (didDrag) {
                finalizeDragSelection();
            }
        }
    });
    
    $(document).on('click', '.time-slot', function(e) {
        if (isRangeMode && !isPainting) {
            handleSingleClick($(this));
        }
    });

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

    $(document).on('mouseenter', '.time-slot', function() {
        const names = $(this).data('names');
        if (names) {
            const element = $(this);
            hoverTimeout = setTimeout(() => {
                showTooltip(element, names);
            }, 1000);
        }
    });

    $(document).on('mouseleave', '.time-slot', function() {
        clearTimeout(hoverTimeout);
        $('.name-tooltip').remove();
    });

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
            events.forEach(event => list.append(`<li><a href="#" class="event-link" data-id="${event.public_id}">${event.name}</a></li>`));
        });
    }
    
    function showEventCalendar(publicId) {
        $.get(`/api/events/${publicId}`, function(response) {
            currentEvent = response;
            $('#main-view').addClass('hidden');
            $('#calendar-view').removeClass('hidden');
            $('#back-to-list-btn').removeClass('hidden');
            $('#event-title').text(response.event.name);
            drawCalendar(response.event, response.unavailability_details);
        });
    }
    
    $(document).on('click', '.event-link', function(e) {
        e.preventDefault();
        showEventCalendar($(this).data('id'));
    });
    
    $('#back-to-list-btn').on('click', showMainView);

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

    function handleApiError(jqXHR) {
        if (jqXHR.status === 404 && jqXHR.responseText.includes("Uzytkownik")) {
            alert('Twoje dane logowania sa nieaktualne. Zostaniesz automatycznie wylogowany.');
            logout();
        } else {
            alert('Wystapil blad operacji.');
        }
    }

    function sendAvailabilityRequest(httpMethod) {
        if (selectedSlots.size === 0) return;
        const promises = [];
        for (const slot of selectedSlots) {
            const [date, tod] = slot.split('|');
            const payload = {
                user_id: currentUser.id,
                start_date: date,
                end_date: date,
                times_of_day: [tod]
            };
            const promise = $.ajax({
                url: `/api/events/${currentEvent.event.public_id}/availability`,
                type: httpMethod, 
                contentType: 'application/json',
                data: JSON.stringify(payload)
            });
            promises.push(promise);
        }
        Promise.all(promises)
            .then(() => {
                selectedSlots.clear();
                $('.time-slot.selected').removeClass('selected');
                showEventCalendar(currentEvent.event.public_id);
            })
            .catch(handleApiError);
    }

    $('#save-availability-btn').on('click', function() {
        sendAvailabilityRequest('POST');
    });

    $('#remove-availability-btn').on('click', function() {
        sendAvailabilityRequest('DELETE');
    });
    
    $('#clear-selection-btn').on('click', function() {
        $('.time-slot.selected').removeClass('selected');
        selectedSlots.clear();
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