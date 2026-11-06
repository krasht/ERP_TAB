// ==UserScript==
// @name         ERP — вкладка «Для ТП» в договоре
// @namespace    https://sd.org.avanta-telecom.ru/
// @version      0.72.7
// @description  Вкладка «Для ТП» рядом с «GetOLT» в карточке договора: данные абонента, оборудование, ошибки Radius, баланс/блокировка, тариф, примечания, кнопка «Доверительный платёж» (лимит). Плюс автозаполнение окна повторного входа
// @author       Vladimir Chugunov
// @match        https://sd.org.avanta-telecom.ru/user
// @match        https://sd.org.avanta-telecom.ru/user/*
// @updateURL    https://raw.githubusercontent.com/krasht/ERP_TAB/main/erp-contract-tp-tab.meta.js
// @downloadURL  https://raw.githubusercontent.com/krasht/ERP_TAB/main/erp-contract-tp-tab.user.js
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    // Защита от повторной загрузки. При обновлении скрипта (или ручной
    // переинъекции при отладке) в странице оказывались две копии: старая
    // продолжала висеть на уже отрисованных кнопках и выполняла устаревшую
    // логику. Из-за этого, например, услуга «Публичный IP» не добавлялась,
    // хотя код был уже исправлен. Новая копия снимает старый обработчик.
    if (window.__erpTpTab) {
        try { window.__erpTpTab.destroy(); } catch (e) { /* старая версия без destroy */ }
    }
    // Единственное место, где поднимается версия: отсюда её берут и защита от
    // повторной загрузки, и проверка обновлений. Раньше строка дублировалась,
    // и версию забывали поднять в одном из двух мест.
    const SELF_VERSION = '0.72.7';
    window.__erpTpTab = { version: SELF_VERSION, destroy: null };

    /**
     * ID панели уникален для каждого договора: ERP держит карточки в #content
     * как отдельные div#contract_bill-N и переключает их через display,
     * поэтому единый ID приводил к тому, что у нового договора вкладки не было.
     */
    const PANEL_ID_BASE = 'contract-tp-info';
    const panelIdFor = (contractId) => `${PANEL_ID_BASE}-${contractId || Date.now()}`;
    const PANEL_SEL = '[id^="' + PANEL_ID_BASE + '-"]';
    const TAB_TITLE = 'Для ТП';

    // Панели, по которым определяем контейнер вкладок карточки договора
    /** Находит панель «Для ТП» внутри конкретной карточки договора. */
    function findPanel(root) {
        const scope = root || document;
        return scope.querySelector(PANEL_SEL) || null;
    }

    /** Активная карточка договора: ERP держит их в #content > div#contract_bill-N. */
    function activeContractDiv() {
        return document.querySelector('#content > div[id^="contract_bill-"]:not([style*="display: none"])')
            || document.querySelector('#content > div[id^="bgbilling-bill-"], #content > div[id^="contract_bill-"]');
    }


    /**
     * Поля абонента, сгруппированные по смыслу.
     *
     * Одним списком из девяти строк карточка читалась как анкета: паспорт, адрес
     * и телефон шли подряд без разбора. Группы дают глазу опору — оператор ищет
     * «Документы» или «Подключение», а не вычитывает весь список.
     */
    const PARAM_GROUPS = [
        ['Контакты', [
            ['Телефон', 'Телефон'],
            ['E-mail', 'E-mail'],
        ]],
        ['Документы', [
            ['Дата рождения', 'Дата рождения'],
            ['Место рождения', 'Место рождения'],
            ['Тип документа', 'Тип документа'],
            ['Паспорт: серия', 'Паспорт: серия'],
            ['Паспорт: номер', 'Паспорт: номер'],
            ['Паспорт: кем выдан', 'Паспорт: кем выдан'],
            ['Паспорт: когда выдан', 'Паспорт: когда выдан'],
        ]],
        ['Подключение', [
            // Номер договора не дублируем: он уже в шапке карточки
            ['Адрес подключения', 'Адрес подключения'],
            ['Адрес регистрации', 'Адрес регистрации'],
        ]],
    ];

    const DEFAULT_DAYS = 3;
    const DEFAULT_COMMENT = 'Доверительный платёж';

    /*
     * Отправка доступа на почту.
     *
     * В ERP письмо — это сообщение процесса (/user/message.do), а не отдельная
     * «почтовая» ручка. Отсюда устройство операции:
     *   1) создаём процесс типа «1 Линия / Обращение абонента» на договоре;
     *   2) в нём создаём сообщение нужного типа (typeId = адрес отправителя);
     *   3) закрываем процесс статусом «Завершено».
     *
     * Почему именно так, а не «просто отправить письмо»: сообщение в ERP без
     * процесса не существует, а оставлять открытое обращение на каждый показ
     * пароля — мусор в очередях поддержки. Поэтому обращение создаётся, письмо
     * уходит и обращение тут же закрывается.
     */

    /** Процесс «1 Линия / Обращение абонента» — его ID типа в этой базе. */
    const PROCESS_TYPE_LINE1 = '28';
    /** Статус «Завершено» — им ERP закрывает процесс. */
    const PROCESS_STATUS_DONE = '4';
    /** Промежуточный «В работе»: из «Новый» в «Завершено» напрямую нельзя. */
    const PROCESS_STATUS_WORK = '2';

    /**
     * Адреса, с которых ERP умеет отправлять письма (typeId сообщения).
     *
     * Список — это типы сообщений, настроенные в биллинге; берём их из формы
     * создания сообщения, а не хардкодим: у другой базы адреса будут свои.
     * Здесь только значения по умолчанию и порядок для выпадающего списка.
     */
    const MAIL_SENDERS = [
        { id: '2', email: 'support@avanta-telecom.ru' },
        { id: '1', email: 'it@avanta-telecom.ru' },
        { id: '3', email: 'monitoring@avanta-telecom.ru' },
        { id: '4', email: 'smr@avanta-telecom.ru' },
        { id: '6', email: 'opora@avanta-telecom.ru' },
    ];
    /** Отправитель по умолчанию — поддержка. */
    const MAIL_DEFAULT_SENDER = '2';
    /** Куда отправлять, если в договоре не заполнен E-mail. */
    const MAIL_FALLBACK_TO = '';
    /** Ключи localStorage для запоминания выбора оператора. */
    const MAIL_STORE_SENDER = 'erpTpMailSender';
    const MAIL_STORE_TO = 'erpTpMailTo';

    /**
     * Абонплата договора в двух видах: в месяц и в день.
     *
     * Доверительный платёж считается по ДНЕВНОЙ абонплате: биллинг понижает лимит
     * на сумму долга плюс начисления за N суток, и сутки он считает по календарю,
     * а не по «среднему месяцу». Раньше здесь было `месячная / дней_в_месяце` —
     * и на договоре 3 это давало 32.20 ₽/день при фактических 41.69 ₽/день:
     * 956 ₽ в «Итого в месяц» — это только тариф и ТВ-абонплата, а ежедневно
     * начисляются ещё бандлы «Комбо Хит» и «Ночной». Ошибка в 9.49 ₽/день
     * на трёх сутках — недобор ~28 ₽, и лимит закрывал договор раньше срока.
     *
     * Источник истины — блок «Списания по дням» на вкладке «Стоимость»: там ERP
     * показывает ровно то, что BGBilling начислил за сутки, со скидками.
     * Берём медиану ненулевых сумм по строкам «Абонплата»: медиана не ломается
     * от дня заморозки (0 ₽) и от единственного дня с разовой услугой.
     * Строки «ТВ» и «Разовая услуга» не берём: пакеты и разовые позиции
     * начисляются не каждые сутки, и в суточной норме они завысили бы прогноз.
     *
     * Если разобрать дни не удалось (новый договор, пустая история) — откат
     * на месячную сумму из «Итого в месяц», делённую на дни месяца.
     */
    async function feeProfile(contractId) {
        const empty = { perDay: 0, perMonth: 0, source: '' };
        try {
            const html = await fetchText(`/user/plugin/dogovor/stoimost.do?billingId=bill&contractId=${contractId}`);
            const body = parseHtml(html);

            // ---- месячная абонплата: «Итого в месяц», колонка «К оплате»
            let perMonth = 0;
            const itog = Array.from(body.querySelectorAll('tr.sv-itog'))
                .find((tr) => /Итого в месяц/i.test(tr.innerText || ''));
            if (itog) {
                const nums = Array.from(itog.querySelectorAll('td'))
                    .map((td) => td.innerText.replace(/[^\d.,-]/g, '').replace(',', '.').trim())
                    .filter((v) => v && /^-?\d+(\.\d+)?$/.test(v));
                if (nums.length) {
                    const value = Number(nums[nums.length - 1]);
                    if (Number.isFinite(value) && value > 0) perMonth = value;
                }
            }

            // ---- дневная абонплата: месячная сумма / 30
            //
            // Именно так считает сам ERP, и оператор сверяет нашу кнопку с
            // оригинальной: «Обещанный платёж: 88 ₽ на 3 дн.» — это 880 / 30 × 3.
            //
            // История правок:
            //   • сначала бралась медиана по дням — она «плыла» при смене тарифа;
            //   • потом самый свежий день — на договоре 2546 это совпало с
            //     оригиналом (ноябрьский день, 30 дней в месяце), но на 71285
            //     дало 85 ₽ вместо 88 ₽: последний день был 31 октября, и та же
            //     сумма 880 ₽ делилась на 31, а не на 30;
            //   • теперь делим на 30 всегда — как ERP. Длина месяца на расчёт
            //     не влияет, поэтому стык месяцев больше не даёт расхождений.
            //
            // Фактические списания по дням остаются в «Стоимости» для справки,
            // но норму мы берём из месячной суммы: она одна и та же независимо
            // от того, 30, 31 или 28 дней в текущем месяце.
            let perDay = 0;
            let source = '';
            if (perMonth > 0) {
                perDay = perMonth / 30;
                source = 'месяц';
            }

            return {
                perDay: Number(perDay.toFixed(2)),
                perMonth,
                source,
            };
        } catch (e) {
            return empty;
        }
    }

    /**
     * Сколько дней в месяце на дату. BGBilling считает абонплату по фактическим
     * дням календаря, а не по фиксированным 30 — иначе день в феврале дешевле
     * январского, а в жизни наоборот.
     */
    function daysInMonth(date) {
        const d = date || new Date();
        return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    }

    /** Абонплата в день по календарю текущего месяца. */
    function feePerDay(feePerMonth, date) {
        const fee = Number(feePerMonth) || 0;
        return fee > 0 ? fee / daysInMonth(date) : 0;
    }

    /**
     * Абонплата в день для расчёта доверительного платежа.
     *
     * Берём норму из feeProfile: там месячная сумма поделена на 30 — ровно так,
     * как считает оригинальный ERP. Раньше приоритет был у «измеренной дневной
     * нормы» из фактических списаний, но она зависит от длины месяца: 31 октября
     * та же сумма делится на 31, и платёж выходил 86 ₽ вместо 88 ₽.
     *
     * Запасной путь — тоже /30, чтобы оба варианта давали одинаковую цифру.
     */
    function trustPerDay(fee) {
        const f = fee || {};
        if (Number.isFinite(f.perDay) && f.perDay > 0) return f.perDay;
        const month = Number(f.perMonth) || 0;
        return month > 0 ? month / 30 : 0;
    }

    /**
     * Сумма доверительного платежа.
     *   долг      = лимит − остаток  (сколько не хватает, чтобы выйти на лимит)
     *   на дни    = абонплата в день (по календарю) × дней
     *   итого     = долг + начисление на дни, с округлением вверх до 10 ₽
     *
     * Долг может быть и нулевым: смысл обещанного платежа не только в том,
     * чтобы закрыть минус, но и в том, чтобы оплатить несколько дней вперёд.
     * У абонента с остатком 14.47 ₽ и лимитом −0.05 ₽ блокировка наступит
     * меньше чем через сутки, хотя лимита он ещё не достиг, — и в оригинальном
     * ERP оператор просто вводит сумму в форму «Лимит». Именно так выглядела
     * запись в журнале 37832: «долг 0 + абонплата 3 сут. 88.00 = 88».
     *
     * Раньше здесь стоял ранний выход `if (!(deficit > 0)) return 0`, и как
     * только остаток оказывался выше лимита, сумма становилась нулевой, а
     * кнопка — неактивной с подписью «Вносить не нужно». На 37832 это и
     * выглядело как «кнопка не работает»: у абонента был запас на половину
     * дня, а платёж на три дня вперёд оставался осмысленным.
     *
     * При этом запас всё же учитывается: если его хватает на весь запрошенный
     * срок, вносить нечего и кнопка должна быть неактивна — иначе она звала бы
     * пополнять заведомо благополучный договор.
     *
     * Возвращает 0, когда вносить действительно нечего.
     */
    function trustAmount(outNum, limitNum, days, fee) {
        if (!Number.isFinite(outNum) || !Number.isFinite(limitNum)) return 0;
        const deficit = Number((limitNum - outNum).toFixed(2)); // > 0, если остаток ниже лимита
        const debt = deficit > 0 ? deficit : 0;
        const perDay = trustPerDay(fee);
        const ahead = perDay * (Number(days) || DEFAULT_DAYS);
        // Запас — это сколько ещё можно потратить до лимита; отрицательный долг.
        const headroom = deficit < 0 ? -deficit : 0;
        // Долга нет и запаса хватает на весь срок — платёж ничего не изменит
        if (!(debt > 0) && !(ahead > headroom)) return 0;
        const total = debt + ahead;
        if (!(total > 0)) return 0;
        // Округление — вверх до целого рубля, как в оригинале ERP.
        //
        // Раньше здесь стояло округление до десятков (`ceil(total / 10) * 10`),
        // и на договоре 2546 платёж за 3 дня выходил 150 ₽ вместо 144 ₽:
        // 48 ₽/день × 3 = 144, а десятки превращали это в 150. Оператор сверяет
        // нашу кнопку с оригинальной, где написано ровно «144 ₽ на 3 дн.».
        //
        // Сверка с журналом биллинга подтверждает правило «до рубля»:
        //   2546:  0 + 144.00 = 144      (ровно)
        //   3:     15681.06 + 116.41 = 15798  (15797.47 вверх до рубля)
        //   37832: 0 + 88.00 = 88        (ровно)
        return Math.ceil(total);
    }

    /**
     * Вердикт по договору: заблокирован ли по балансу, сколько внести,
     * сколько связи осталось. Один источник правды для buildContent и fillConnection.
     *
     * Про статусы — по документации BGBilling «Статус договора» (43384998.html):
     *   • перечень статусов задаётся переменной contract.status.list и у каждого
     *     экземпляра свой: «Активен», «В отключении», «Отключен», «Закрыт»,
     *     «Приостановлен», «Заморозка», «В подключении»… Перебирать названия
     *     бессмысленно — их состав меняется конфигурацией;
     *   • активные статусы модулей задаются contract.status.active.codes,
     *     приостановленные — contract.status.suspend.codes;
     *   • для ДЕБЕТОВОГО договора статус ставит только администратор, и перевод
     *     в ЛЮБОЙ неактивный статус блокирует модули. Поступление денег ситуацию
     *     НЕ меняет.
     *
     * Отсюда правило: любой статус, который не начинается с «Актив», считается
     * блокирующим по статусу. Раньше здесь проверялись только «закрыт» и
     * «приостановлен», и договор со статусом «Заморозка» выглядел как обычный
     * с отсутствующей сессией: панель писала «не подключён», хотя услуги
     * отключены статусом и платёж их не вернёт.
     */
    function connectionVerdict(outNum, limitNum, statusText, aliveCount) {
        const hasData = Number.isFinite(outNum) && Number.isFinite(limitNum);
        const deficit = hasData ? Number((limitNum - outNum).toFixed(2)) : 0; // > 0 = нужно внести
        const blockedByBalance = hasData && deficit > 0;

        const status = String(statusText || '').trim();
        const isActiveStatus = !status || /^актив/i.test(status);
        // Неактивный статус — это и «Закрыт», и «Приостановлен», и «Заморозка»,
        // и любой другой, заведённый в конфигурации. Договор без статуса
        // (пустое значение) считаем активным: это нормальный случай, когда
        // узел «Статус» ещё не отрисован.
        const isClosed = !isActiveStatus && /закрыт|удал|отключ/i.test(status);
        const isSuspended = !isActiveStatus && !isClosed;

        const online = Number(aliveCount) > 0;
        return {
            hasData,
            blockedByBalance,
            isClosed,
            isSuspended,
            // Готовое имя статуса — чтобы подпись говорила «Заморозка», а не
            // общее «приостановлен»: оператор ищет в ERP ровно это слово.
            statusText: status,
            isActive: isActiveStatus,
            online,
            needPay: deficit > 0 ? deficit : 0,
            headroom: deficit < 0 ? Number((-deficit).toFixed(2)) : 0,
            // Причина офлайна для подписи — деньги важнее статуса договора
            offlineReason: blockedByBalance ? 'баланс'
                : isClosed ? 'договор закрыт'
                    : isSuspended ? `статус «${status || 'не активен'}»`
                        : 'не подключён',
            // деньги не виноваты, но связи нет — оператору не надо трогать лимит
            notMoney: !blockedByBalance && !online,
        };
    }

    const MONTHS_RU = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
        'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

    /** Русские склонения: 1 день / 2 дня / 5 дней. */
    function plural(n, one, few, many) {
        const n10 = n % 10;
        const n100 = n % 100;
        if (n10 === 1 && n100 !== 11) return one;
        if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return few;
        return many;
    }

    /** Сколько дней остаётся до блокировки по балансу + примерная дата. */
    function daysUntilBlock(outNum, limitNum, fee) {
        const perDay = trustPerDay(fee);
        if (!Number.isFinite(outNum) || !Number.isFinite(limitNum) || !(perDay > 0)) return null;
        const headroom = limitNum - outNum; // < 0 — запас ещё есть
        if (headroom >= 0) return null;     // уже в блоке, прогноз не нужен
        const days = Math.floor(-headroom / perDay);
        const date = new Date();
        date.setDate(date.getDate() + days);
        // Меньше суток — это не «0 дней»: так читалось как «уже заблокирован»
        const label = days > 365
            ? 'больше года'
            : days === 0
                ? 'меньше дня'
                : `${days} ${plural(days, 'день', 'дня', 'дней')}`;
        return {
            days,
            label,
            date: `${date.getDate()} ${MONTHS_RU[date.getMonth()]}`,
            warn: days < 7,
        };
    }

    let contentBuilder = () => '';

    /**
     * Запрос к ERP без таймаута.
     * Методы ERP бывают очень медленными (история статусов — до 25 с, платежи — до 10 с),
     * а любой таймаут на клиенте обрывает запрос раньше, чем сервер ответит.
     * Сборка запросов через эту функцию оставлена ради единой точки и удобных заголовков.
     */
    function fetchText(url) {
        const key = String(url);
        const now = Date.now();

        // Свежий ответ из кэша — без обращения к сети.
        // Попадание ПЕРЕНОСИТ запись в конец: Map хранит порядок вставки,
        // и без переноса вытеснялась самая старая по вставке запись, а не
        // самая давно использованная. Справочник устройств с TTL 5 минут
        // мог быть выброшен ради случайного ответа, который больше не нужен.
        const hit = NET.cache.get(key);
        if (hit && hit.until > now) {
            NET.cache.delete(key);
            NET.cache.set(key, hit);
            return Promise.resolve(hit.text);
        }
        if (hit) NET.cache.delete(key);

        // Такой же запрос уже в пути — ждём его, а не дублируем
        const pending = NET.inflight.get(key);
        if (pending) return pending;

        const ttl = ttlFor(key);
        const promise = netRun(() => fetch(key, { credentials: 'same-origin' })
            .then((r) => r.text())
            .then((t) => {
                // Истёкшая сессия отдаёт страницу входа с кодом 200. Без этой
                // проверки она выглядела как валидный ответ: в ней нет ни данных,
                // ни исключения, и разбор молча возвращал пустоту. Так «Белый IP»
                // показывал «нет доступных устройств» вместо «перелогиньтесь».
                if (/name="j_password"/.test(t)) {
                    throw new Error('Сессия ERP истекла — обновите страницу и войдите заново');
                }
                // Страницу входа и ошибки не кэшируем: сессия могла восстановиться
                if (ttl > 0 && t.length < 4000000) {
                    NET.cache.set(key, { text: t, until: Date.now() + ttl });
                    NET.bytes += t.length;
                    // Верхние границы: у карточки за смену набираются сотни
                    // ответов. Считаем и количество, и суммарный размер —
                    // 240 ответов «Стоимости» могут занять сотни мегабайт.
                    while (NET.cache.size > NET.maxEntries || NET.bytes > NET.maxBytes) {
                        const oldest = NET.cache.keys().next();
                        if (oldest.done) break;
                        const drop = NET.cache.get(oldest.value);
                        if (drop) NET.bytes -= (drop.text || '').length;
                        NET.cache.delete(oldest.value);
                    }
                }
                return t;
            }))
            .finally(() => { NET.inflight.delete(key); });

        NET.inflight.set(key, promise);
        return promise;
    }

    /* ------------------------------------------------------------------ utils */

    /**
     * Приводит сумму из ERP к числу.
     * ERP отдаёт суммы с обычным пробелом и nbsp как разделителем тысяч,
     * с запятой вместо точки и с типографским минусом U+2212.
     * Всё это раньше давало NaN, а NaN в расчёте лимита — это «платёж не нужен».
     */
    const toNum = (v) => {
        if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
        const s = String(v == null ? '' : v)
            .replace(/[\u2212\u2013\u2014]/g, '-')
            .replace(/[\s\u00a0\u202f]/g, '')
            .replace(/,/g, '.');
        // Пустая строка — это «нет данных», а не 0: Number('') === 0 дал бы ложный лимит 0
        if (!s || !/^-?\d*\.?\d+$/.test(s)) return NaN;
        const n = Number(s);
        return Number.isFinite(n) ? n : NaN;
    };

    const fmt = (v) => {
        const n = toNum(v);
        return Number.isFinite(n) ? n.toFixed(2) : String(v == null ? '' : v);
    };

    const esc = (s) => String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

    const parseHtml = (html) => {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        return doc.body || doc.documentElement;
    };

    const postForm = (url, data) => {
        const body = new URLSearchParams(data).toString();
        return fetch(url, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
        }).then((r) => r.text()).then((t) => {
            // POST меняет данные договора, но не справочники. Раньше здесь
            // сбрасывался ВЕСЬ кэш: после каждой заметки, лимита или письма
            // панель заново запрашивала дерево устройств (TTL 5 минут),
            // параметры (2 минуты) и «Стоимость» (1.5 минуты) — хотя они
            // не изменились. Сбрасываем только то, что POST мог затронуть.
            netDrop(/contract|session|balance|serviceTree|method=serviceGet|memo|limit|npay|paymentList|contractCards|stoimost/i);
            return t;
        });
    };

    /* ------------------------------------------------- сеть: кэш и очередь */

    /**
     * Кэш ответов ERP и очередь запросов.
     *
     * Панель собирается из полутора десятков ручек ERP, и одни и те же адреса
     * запрашивались по нескольку раз за одну отрисовку:
     *   stoimost.do — ради абонплаты и ради состава тарифа;
     *   balance.do  — ради баланса, остатка за период и «фактически начислено»;
     *   serviceTree — ради сессий, «Белого IP», «Сервисов» и закрытия сервиса.
     * Автообновление раз в 7 секунд тянуло всё это заново, хотя баланс и пароли
     * за это время не меняются.
     *
     * Здесь две вещи:
     *  • склейка одинаковых запросов — пока запрос в пути, второй такой же
     *    ждёт его ответ, а не открывает соединение заново;
     *  • короткий TTL — повторный запрос в пределах срока отдаётся из памяти.
     *    Срок свой у каждого типа данных: живые сессии — секунды, справочник
     *    устройств и «Стоимость» — минуты.
     *
     * Ключ — полный URL, поэтому данные разных договоров не смешиваются.
     */
    const NET = {
        cache: new Map(),
        inflight: new Map(),
        // Браузер держит на домен не больше шести соединений; очередь нужна,
        // чтобы ERP не получала залп из тридцати ручек и не тормозила всю вкладку.
        maxParallel: 6,
        active: 0,
        queue: [],
        maxEntries: 240,
        /** Суммарный размер кэша в символах: 240 ответов «Стоимости» — это сотни МБ. */
        maxBytes: 32 * 1024 * 1024,
        bytes: 0,
    };

    /**
     * Сколько ждёт один запрос, прежде чем освободить слот, мс.
     *
     * Без ограничения шесть зависших ответов ERP останавливали очередь
     * НАВСЕГДА: NET.active не уменьшался, новые задачи не запускались,
     * и панель «умирала» до перезагрузки страницы. Запрос при этом не
     * обрывается — мы лишь перестаём держать на нём слот и отдаём ошибку.
     */
    const NET_TIMEOUT_MS = 30000;

    /** Сколько живёт ответ конкретной ручки, мс. */
    const NET_TTL = [
        // Живые сессии — единственное, что должно быть свежим всегда
        [/sessionAliveContractList/i, 4000],
        // Ошибки Radius: их и так запрашивают окнами по 5 штук
        [/radius\.do/i, 40000],
        // Дерево устройств — почти статичный справочник
        [/devicesGet/i, 300000],
        [/freeIpList/i, 60000],
        [/stoimost\.do/i, 90000],
        [/balance\.do/i, 45000],
        [/serviceTree|method=serviceGet/i, 90000],
        [/contractCards/i, 90000],
        [/parameterList|contractObjectList/i, 120000],
        [/getolt/i, 90000],
        [/memoList/i, 20000],
        [/sessionLogContractList/i, 60000],
        [/method=status|method=limit|paymentList/i, 60000],
        [/npay\.do|contractTariff\.do/i, 90000],
    ];

    const ttlFor = (url) => {
        for (let i = 0; i < NET_TTL.length; i += 1) {
            if (NET_TTL[i][0].test(url)) return NET_TTL[i][1];
        }
        return 30000;
    };

    /** Сброс кэша: без аргумента — весь, с шаблоном — только подходящие адреса. */
    function netDrop(pattern) {
        if (!pattern) {
            NET.cache.clear();
            NET.bytes = 0;
            return;
        }
        const re = pattern instanceof RegExp ? pattern : new RegExp(pattern);
        Array.from(NET.cache.keys()).forEach((k) => {
            if (!re.test(k)) return;
            const drop = NET.cache.get(k);
            if (drop) NET.bytes -= (drop.text || '').length;
            NET.cache.delete(k);
        });
    }

    /**
     * Запуск задачи с ограничением числа одновременных запросов.
     *
     * Таймаут освобождает слот, даже если сам fetch не завершился: иначе
     * несколько зависших ответов ERP блокировали очередь навсегда.
     */
    function netRun(task) {
        return new Promise((resolve, reject) => {
            const run = () => {
                NET.active += 1;
                let done = false;

                const release = () => {
                    if (done) return;
                    done = true;
                    clearTimeout(timer);
                    NET.active -= 1;
                    const next = NET.queue.shift();
                    if (next) next();
                };

                const timer = setTimeout(() => {
                    if (done) return;
                    release();
                    reject(new Error('ERP не ответила за ' + Math.round(NET_TIMEOUT_MS / 1000) + ' с'));
                }, NET_TIMEOUT_MS);

                let p;
                try { p = task(); } catch (e) { p = Promise.reject(e); }
                p.then((v) => { release(); resolve(v); }, (e) => { release(); reject(e); });
            };
            if (NET.active < NET.maxParallel) run();
            else NET.queue.push(run);
        });
    }

    /**
     * Разбор ответа биллинга в форме {"status":"ok"|"error","message":"…"}.
     *
     * Так отвечают updateMemo/deleteMemo и часть методов npay. Проверять
     * «нет ли слова error в тексте» нельзя: сообщение об успехе может его
     * содержать, а HTML-ошибка приходит вообще без JSON.
     * Возвращает { ok, message } — message уже готов к показу оператору.
     */
    const jsonVerdict = (text) => {
        const raw = String(text == null ? '' : text).trim();
        let json = null;
        try { json = JSON.parse(raw); } catch (e) { /* не JSON — разберём текстом */ }
        if (json && typeof json === 'object') {
            const ok = !json.status || json.status === 'ok';
            return { ok, message: String(json.message || '').slice(0, 300) };
        }
        const plain = raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        if (/^<!DOCTYPE|^<html/i.test(raw) || !plain) {
            return { ok: false, message: 'Биллинг вернул пустой ответ' };
        }
        // Текстовый отказ ERP: «Переход со статуса 1 на статус 4 невозможен»,
        // «Действие запрещено», «не найдено». Раньше здесь ловились только
        // «нельзя/недопустим», и отказ с «невозможен» считался успехом —
        // обращение после письма оставалось открытым, а оператор видел «Готово».
        const err = plain.match(/(Ошибка|Exception|не найден|нельзя|недопустим|невозможен|запрещено)[^.]{0,150}/i);
        return { ok: !err, message: err ? err[0] : plain.slice(0, 200) };
    };

    const todayRu = () => {
        const d = new Date();
        const p = (n) => String(n).padStart(2, '0');
        return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`;
    };

    /** Вчерашняя дата — старый сервис закрывается ею, чтобы не рвать текущий день. */
    const yesterdayRu = () => {
        const d = new Date();
        d.setDate(d.getDate() - 1);
        const p = (n) => String(n).padStart(2, '0');
        return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`;
    };

    /**
     * MAC-адрес в формате биллинга: a4ba.7002.8a61.
     *
     * Оператор вводит его как удобно — с двоеточиями, дефисами, точками
     * или сплошной строкой. Биллинг понимает только вид xxxx.xxxx.xxxx,
     * поэтому любые разделители убираем и ставим точки через каждые 4 символа.
     *
     * Возвращает '' если после очистки осталось не 12 hex-символов:
     * лучше не отправить мусор, чем создать сервис с битым MAC.
     */
    function normalizeMac(raw) {
        const hex = String(raw || '').toLowerCase().replace(/[^0-9a-f]/g, '');
        if (hex.length !== 12) return '';
        return `${hex.slice(0, 4)}.${hex.slice(4, 8)}.${hex.slice(8, 12)}`;
    }

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    /**
     * Публичный ли адрес.
     *
     * Серые сети (10/8, 172.16/12, 192.168/16, CGNAT 100.64/10) для белого IP
     * не годятся: адрес из них выдаётся динамически и абоненту не принадлежит.
     * Раньше эта проверка жила внутри loadWhiteIp, но нужна и при обновлении
     * после выдачи/снятия — поэтому вынесена на уровень модуля.
     */
    function isPublicIp(ip) {
        if (!ip) return false;
        const a = String(ip).split('.').map(Number);
        if (a.length !== 4 || a.some((n) => !Number.isFinite(n))) return false;
        if (a[0] === 10) return false;                       // 10.0.0.0/8
        if (a[0] === 127) return false;                      // loopback
        if (a[0] === 0) return false;                        // 0.0.0.0
        if (a[0] === 172 && a[1] >= 16 && a[1] <= 31) return false; // 172.16/12
        if (a[0] === 192 && a[1] === 168) return false;      // 192.168/16
        if (a[0] === 100 && a[1] >= 64 && a[1] <= 127) return false; // CGNAT
        if (a[0] === 169 && a[1] === 254) return false;      // link-local
        return true;
    }

    /**
     * Опрос с паузами: ждёт, пока fn() не вернёт истину.
     *
     * Биллинг применяет сервис не мгновенно — между ответом на serviceCreate
     * и появлением адреса в дереве проходит от долей секунды до нескольких.
     * Задержки нарастающие: первые секунды опрашиваем часто, дальше реже,
     * чтобы не заваливать ERP запросами.
     */
    async function waitUntil(fn, delays) {
        const steps = (delays && delays.length) ? delays : [0, 800, 1800, 3200, 5000];
        let prev = 0;
        for (let i = 0; i < steps.length; i += 1) {
            const wait = steps[i] - prev;
            if (wait > 0) await sleep(wait);
            prev = steps[i];
            try {
                if (await fn()) return true;
            } catch (e) { /* сеть моргнула — попробуем ещё раз */ }
        }
        return false;
    }

    /* --------------------------------------------------------- ERP data layer */

    const ERP = {
        /**
         * Поддерживаем два способа открытия договора в ERP:
         *  1) вкладки в одной странице  — /user/contract_bill#6532
         *  2) отдельная карточка        — /user/plugin/bgbilling/contract.do?billingId=bill&id=6532
         */
        /**
         * ID договора берём в порядке приоритета:
         *  1) из контейнера карточки, внутри которой находимся (ERP держит их как div#contract_bill-N);
         *  2) из query (?id=), если открыта отдельная страница плагина;
         *  3) из hash;
         *  4) из якорей вкладок договоров.
         * Раньше первым шёл hash — и при нескольких открытых договорах данные подтягивались чужие.
         */
        contractId(scope) {
            // 1) Карточка, внутри которой вызван скрипт
            const host = scope || document.querySelector('#content > div[id^="contract_bill-"]:not([style*="display: none"])');
            if (host && host.id) {
                const fromCard = host.id.match(/^contract_bill-(\d+)$/);
                if (fromCard) return fromCard[1];
            }

            // 2) Отдельная страница плагина
            const fromQuery = location.search.match(/[?&]id=(\d+)/);
            if (fromQuery) return fromQuery[1];

            // 3) Hash
            const fromHash = (location.hash || '').match(/#(\d+)/);
            if (fromHash) return fromHash[1];

            // 4) Якоря вкладок договоров (при открытии из поиска hash появляется позже)
            const anchors = Array.from(document.querySelectorAll('.ui-tabs-nav > li > a[href^="#"]'));
            const numeric = anchors
                .map((a) => a.getAttribute('href').slice(1))
                .filter((h) => /^\d+$/.test(h));
            return numeric.length ? numeric[numeric.length - 1] : '';
        },

        /**
         * Заголовок карточки договора («BILL0900078 (ФИО)»).
         *
         * Устройство разметки ERP (проверено на живой карточке): договор
         * представлен ДВУМЯ узлами с одинаковым id — `contract_bill-N`:
         *   • в блоке `#title` — шапка с заголовком h1.title и кнопкой закрытия;
         *   • в блоке `#content` — сама карточка с вкладками и таблицей.
         * Заголовок с номером и ФИО живёт в ПЕРВОМ, а данные (treeTable,
         * параметры) — во втором. Поэтому искать h1 внутри карточки из
         * #content бессмысленно: там его нет, и номер договора получался пустым.
         *
         * Раньше здесь был запасной `document.querySelector('#content h1, h1')`,
         * то есть при неудаче запрос уходил на всю страницу и брал первый <h1>.
         * При нескольких открытых договорах это давало ФИО чужого абонента —
         * отсюда «информация отличается от того договора, на который захожу».
         *
         * Теперь ищем заголовок строго своей карточки: сначала в шапке #title
         * по тому же id, затем (на случай другой вёрстки) внутри переданного узла.
         */
        contractTitle(root) {
            const fromNode = (el) => {
                if (!el) return '';
                const h1 = el.querySelector('h1.title, h1, .title');
                return h1 ? h1.innerText.trim() : '';
            };

            const scope = root || null;
            const cid = scope && scope.id ? (String(scope.id).match(/(\d+)$/) || [])[1] : '';

            // 1) Шапка договора в блоке #title — там лежит настоящий h1
            if (cid) {
                const head = document.getElementById('title');
                const headCard = head ? head.querySelector(`div#contract_bill-${cid}`) : null;
                const title = fromNode(headCard);
                if (title) return title;
            }

            // 2) Заголовок внутри переданного узла (иная вёрстка / отдельная страница)
            const own = fromNode(scope);
            if (own) return own;

            // 3) Фолбэк только когда карточка на странице одна: при нескольких
            //    договорах любой общий поиск вернёт чужой заголовок.
            const cards = document.querySelectorAll('#content > div[id^="contract_bill-"]');
            if (cards.length === 1) return fromNode(document.getElementById('title'));
            return '';
        },

        /**
         * Номер договора для фильтров (BILL0039506), без ФИО из заголовка карточки.
         * Radius Logs фильтрует по этому номеру, а не по numeric contractId.
         *
         * Главный источник — ссылки вкладок карточки: ERP сама кладёт номер в
         * contractNumber=… (GetOLT) и objectTitle=… (Документы). Это надёжнее
         * разбора текста: у скрытых карточек innerText пустой, а в разметке
         * встречаются служебные id вида UIID…, которые легко принять за номер.
         */
        contractNumber(cid) {
            const fromUrl = (raw) => {
                if (!raw) return '';
                const m = String(raw).match(/[?&](?:contractNumber|objectTitle)=([^&]+)/i);
                if (!m) return '';
                const val = decodeURIComponent(m[1].replace(/\+/g, ' ')).trim();
                return /^[A-Z]{2,}\d{4,}$/i.test(val) ? val.toUpperCase() : '';
            };

            const host = cid
                ? document.querySelector(`#content > div#contract_bill-${cid}`)
                : document.querySelector('#content > div[id^="contract_bill-"]:not([style*="display: none"])');

            if (host) {
                const links = Array.from(host.querySelectorAll('.ui-tabs-nav a[href]'));
                for (let i = 0; i < links.length; i++) {
                    const num = fromUrl(links[i].getAttribute('href'));
                    if (num) return num;
                }
                // Тот же номер есть в любой ссылке внутри СВОЕЙ карточки
                // (GetOLT, Документы, Процессы). Раньше поиск шёл по всему
                // документу, и при нескольких открытых договорах возвращался
                // номер первого из них — панель показывала чужой договор.
                const ownLink = Array.from(host.querySelectorAll('a[href*="contractNumber="]'))
                    .map((a) => fromUrl(a.getAttribute('href')))
                    .filter(Boolean);
                if (ownLink.length) return ownLink[0];
            }

            // Запасной путь — текст заголовка карточки, без script/style и без UIID…
            const cleanText = (el) => {
                if (!el) return '';
                const clone = el.cloneNode(true);
                Array.from(clone.querySelectorAll('script, style')).forEach((n) => n.remove());
                return String(clone.textContent || '').replace(/\s+/g, ' ').trim();
            };
            const sources = [];
            if (host) {
                const titleEl = host.querySelector('h1.title, .title');
                if (titleEl) sources.push(cleanText(titleEl));
                sources.push(cleanText(host));
            }
            for (let i = 0; i < sources.length; i++) {
                const m = String(sources[i] || '').match(/\b([A-Z]{2,}\d{4,})\b/);
                if (m && !/^UIID/i.test(m[1])) return m[1].toUpperCase();
            }
            return '';
        },

        /**
         * Параметры договора из панели «Параметры» + Статус/Лимит/Исходящий остаток.
         */
        /** Параметры договора: сначала из карточки, если «Параметры договора» не открыты — ничего. */
        async params(cid) {
            const result = { fields: {}, status: '', limit: '', balanceOut: '', balanceMonth: '', objects: '', mode: '', person: '' };

            /*
             * Читаем ТОЛЬКО карточку своего договора.
             *
             * Раньше при ненайденной карточке здесь стоял запасной `document`,
             * и запрос `#treeTable` уходил на всю страницу — то есть брал
             * таблицу первого открытого договора. В ERP можно держать открытыми
             * несколько карточек (div#contract_bill-N), поэтому панель нового
             * договора показывала статус, лимит и остаток чужого.
             *
             * Теперь при отсутствии карточки возвращаем пустые значения:
             * блоки честно покажут «нет данных», а не чужие числа. Данные,
             * которых не хватает, всё равно догрузятся отдельными ручками
             * (баланс, лимит, параметры) уже по своему contractId.
             */
            const scope = cid
                ? document.querySelector(`#content > div#contract_bill-${cid}`)
                : document.querySelector('#content > div[id^="contract_bill-"]:not([style*="display: none"])');
            if (!scope) return result;

            scope.querySelectorAll('#treeTable tr').forEach((tr) => {
                const cells = tr.querySelectorAll('td');
                // textContent, а не innerText: innerText заставляет браузер
                // пересчитывать вёрстку на КАЖДОЕ чтение, а этот цикл идёт
                // по всем строкам живой таблицы и вызывается дважды за
                // отрисовку панели. В ячейках #treeTable нет <br> и скрытых
                // узлов, поэтому текст совпадает.
                const text = tr.textContent.replace(/\s+/g, ' ').trim();

                if (cells.length >= 2) {
                    const key = cells[0].textContent.replace(/\s+/g, ' ').trim();
                    let val = cells[1].textContent.replace(/\s+/g, ' ').trim();
                    if (key === 'Статус') result.status = val;
                    else if (key === 'Лимит') result.limit = val;
                    else if (key === 'Исходящий остаток') result.balanceOut = val;
                    else if (key === 'Режим') result.mode = val;
                    else if (key === 'Лицо') result.person = val;
                    else if (key === 'Объекты договора') {
                        // В ERP строка может быть как «0 / 0», так и «Объекты договора 0 / 0»
                        const fromKey = (key.match(/(\d+\s*\/\s*\d+)/) || [])[1];
                        result.objects = fromKey || val;
                    } else if (/^Объекты договора/.test(text)) {
                        result.objects = (text.match(/(\d+\s*\/\s*\d+)/) || [])[1] || '';
                    }
                }

                // «Баланс (ноябрь 2026)» — строка-заголовок в одну ячейку, поэтому
                // раньше в ветку cells.length >= 2 она не попадала и месяц баланса
                // не заполнялся никогда.
                if (cells.length >= 1) {
                    const m = text.match(/^Баланс\s*\(([^)]+)\)/);
                    if (m) result.balanceMonth = m[1].trim();
                }
            });

            // Таблица «Параметры договора»: ID | Параметр | Значение
            Object.assign(result.fields, this.readParamTable(scope));

            // Если карточка не на «Параметрах договора», DOM пуст — догружаем ключевые данные.
            // Без этого вкладка «Для ТП» показывает только номер договора.
            if (!Object.keys(result.fields).length) {
                try {
                    const remote = await this.paramsRemote(cid);
                    Object.assign(result.fields, remote.fields || remote);
                } catch (e) { /* останемся с тем, что есть */ }
            }
            return result;
        },

        /** Разбор таблицы параметров (ID | Параметр | Значение) из DOM-узла. */
        readParamTable(root) {
            const fields = {};
            root.querySelectorAll('tr').forEach((tr) => {
                const tds = tr.querySelectorAll('td');
                if (tds.length < 3) return;
                // textContent вместо innerText: этот цикл идёт по всем строкам
                // живой карточки, а innerText на каждой ячейке — принудительный
                // пересчёт вёрстки.
                const id = tds[0].textContent.trim();
                const name = tds[1].textContent.replace(/\s+/g, ' ').trim();
                const value = tds[2].textContent.replace(/\s+/g, ' ').trim();
                if (!/^\d+$/.test(id)) return;
                if (!name || !value) return;
                if (name === 'Параметр' || name === 'Значение') return;
                if (!(name in fields)) fields[name] = value;
            });
            return fields;
        },

        /** Параметры договора с сервера — на случай, если панель «Параметры» ещё не отрисована. */
        async paramsRemote(cid) {
            const id = cid || this.contractId();
            if (!id) return {};
            const html = await fetchText(
                `/user/plugin/bgbilling/proto/contract.do?billingId=bill&contractId=${id}&method=parameterList`
            );
            return this.readParamTable(parseHtml(html));
        },

        tariff(cid) {
            const scope = cid
                ? (document.querySelector(`#content > div#contract_bill-${cid}`) || document)
                : document;
            const rows = Array.from(scope.querySelectorAll('#treeTable tr'));
            const out = { plans: [], modules: [] };
            let section = '';

            rows.forEach((tr) => {
                // Одно чтение на строку: раньше innerText брался трижды
                // (заголовок раздела, текст строки, повтор для плана), а каждое
                // чтение innerText — это пересчёт вёрстки.
                const text = tr.textContent.replace(/\s+/g, ' ').trim();
                if (!text) return;
                if (/^Тарифные планы/i.test(text)) { section = 'tariff'; return; }
                if (/^Модули/i.test(text)) { section = 'modules'; return; }
                if (/^Группы|^Скрипт поведения|^Доп\. действия|^Примечания|^Баланс \(/i.test(text)) { section = ''; return; }

                const cells = tr.querySelectorAll('td');
                if (section === 'tariff' && cells.length) {
                    if (!/^Тарифные планы$/i.test(text)) out.plans.push(text);
                }
                if (section === 'modules' && cells.length >= 2) {
                    const name = cells[0].textContent.replace(/\s+/g, ' ').trim();
                    const cnt = cells[cells.length - 1].textContent.replace(/\s+/g, ' ').trim();
                    if (name) out.modules.push({ name, count: cnt });
                }
            });

            return out;
        },

        /**
         * Оборудование договора (Объекты договора). */
        async equipment(cid) {
            const id = cid || this.contractId();
            if (!id) return [];
            const html = await fetchText(
                `/user/plugin/bgbilling/proto/contract.do?billingId=bill&contractId=${id}&method=contractObjectList`
            );

            const body = parseHtml(html);
            const items = [];

            // Колонки: [кнопки] | ID | Период | Название | Тип
            body.querySelectorAll('table.data tr').forEach((tr) => {
                const cells = Array.from(tr.querySelectorAll('td'))
                    .map((td) => td.innerText.replace(/\s+/g, ' ').trim());

                const idIdx = cells.findIndex((c) => /^\d+$/.test(c));
                if (idIdx < 0) return; // заголовок или служебная строка

                const id = cells[idIdx];
                const period = cells[idIdx + 1] || '';
                const name = cells[idIdx + 2] || '';
                const type = cells[idIdx + 3] || '';

                if (!name || name === 'Название') return;
                items.push({ id, period, name, type });
            });
            return items;
        },

        /**
         * ONU с порта OLT через плагин GetOLT.
         *
         * GetOLT — отдельный плагин ERP (не BGBilling), его вкладка в карточке
         * ведёт на /user/plugin/getolt/getolt.do?method=contractOnu с номером
         * договора. Там же оператор видит данные терминала: модель, серийник,
         * порт OLT, VLAN и уровни сигнала.
         *
         * Разметку плагин может менять при обновлении, поэтому разбираем
         * устойчиво: сначала ищем готовые пары «подпись — значение» (label/value,
         * th/td, «Подпись: значение»), а если их нет — вытаскиваем узнаваемые
         * поля регулярками по тексту. Возвращаем нормализованный набор полей,
         * а renderer решает, что показывать.
         */
        async getolt(cid) {
            const id = cid || this.contractId();
            if (!id) return { ok: false, onu: [], reason: 'no-contract' };

            // Ссылка вкладки — самый надёжный источник: ERP сама кладёт туда
            // contractNumber, без которого плагин не найдёт договор.
            const host = document.querySelector(`#content > div#contract_bill-${id}`)
                || document.querySelector('#content > div[id^="contract_bill-"]');
            let href = '';
            if (host) {
                const a = Array.from(host.querySelectorAll('.ui-tabs-nav a[href*="getolt"]'))
                    .map((x) => x.getAttribute('href') || '')
                    .find((h) => /contractId=/.test(h));
                if (a) href = a;
            }
            if (!href) {
                const num = this.contractNumber(id);
                if (!num) return { ok: false, onu: [], reason: 'no-link' };
                // Реальный путь плагина — /user/plugin/inetip/getolt.do (проверено
                // на живой карточке). Старый /user/plugin/getolt/ отдаёт Invalid path.
                href = `/user/plugin/inetip/getolt.do?method=onu`
                    + `&billingId=bill&contractId=${encodeURIComponent(id)}`
                    + `&contractNumber=${encodeURIComponent(num)}`;
            }

            let html = '';
            try {
                html = await fetchText(href);
            } catch (e) {
                return { ok: false, onu: [], reason: 'fetch-failed', href };
            }
            if (!html || /Invalid path|Доступ запрещ|нет прав/i.test(html)) {
                return { ok: false, onu: [], reason: 'no-access', href };
            }

            const onu = parseGetoltOnu(html);
            return { ok: true, onu, href, reason: onu.length ? '' : 'empty' };
        },

        /* ------------------------------------------- почта: процесс и сообщение */

        /**
         * Создание процесса «1 Линия / Обращение абонента» на договоре.
         *
         * ERP делает это формой /user/process/link.do с method=linkedProcessCreate:
         * привязка к объекту (contract:bill) и тип процесса. Возвращает
         * { ok, id, message }: id нужен, чтобы создать в процессе сообщение
         * и потом закрыть его.
         *
         * Ответ — JSON {"status":"ok","data":{"process":{"id":…}}}. Если ERP
         * вернула HTML или ошибку, id не будет — вызывающий покажет причину.
         */
        async createProcess(cid, opts) {
            const id = cid || this.contractId();
            if (!id) throw new Error('Нет ID договора');
            const o = opts || {};

            const body = new URLSearchParams({
                method: 'linkedProcessCreate',
                id: String(id),
                objectType: 'contract:bill',
                objectTitle: o.objectTitle || this.contractNumber(id) || '',
                billingId: 'bill',
                typeId: String(o.typeId || PROCESS_TYPE_LINE1),
                description: o.description || '',
            });

            const res = await fetch('/user/process/link.do', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body,
            });
            const text = await res.text();

            let json = null;
            try { json = JSON.parse(text); } catch (e) { /* не JSON — разберём текстом */ }

            const processId = json && json.data && json.data.process && json.data.process.id;
            if (processId) return { ok: true, id: String(processId), message: '' };

            if (json && json.status && json.status !== 'ok') {
                return { ok: false, id: '', message: String(json.message || json.status).slice(0, 160) };
            }
            const plain = String(text).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
            const err = plain.match(/(Ошибка|Exception|не найден|запрещено|нельзя)[^.]{0,120}/i);
            return { ok: false, id: '', message: (err ? err[0] : plain).slice(0, 160) };
        },

        /**
         * Отправка сообщения в процессе — это и есть отправка письма.
         *
         * Форма ERP (/user/message.do, method=processMessageCreateUpdate):
         *   processId — процесс, к которому привязано сообщение;
         *   typeId    — тип сообщения, он же адрес отправителя
         *               (support@, it@, monitoring@…);
         *   to        — получатель (может быть несколько через запятую);
         *   subject   — тема; text — тело;
         *   tagId     — «вложить историю» (0 — не вкладывать).
         *
         * Возвращает { ok, message }. Успех ERP отдаёт как {"status":"ok"}.
         */
        async sendProcessMessage(processId, opts) {
            const pid = processId || '';
            if (!pid) throw new Error('Нет ID процесса');
            const o = opts || {};

            const body = new URLSearchParams({
                method: 'processMessageCreateUpdate',
                processId: String(pid),
                id: '',
                areaId: 'process-message-add',
                checkEmptySubject: '1',
                to: o.to || '',
                toCc: o.toCc || '',
                updateTags: '1',
                tagId: String(o.tagId || '0'),
                data: '',
                subject: o.subject || '',
                text: o.text || '',
                addFileId: '',
                typeId: String(o.typeId || MAIL_DEFAULT_SENDER),
            });

            const res = await fetch('/user/message.do', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body,
            });
            const text = await res.text();
            return jsonVerdict(text);
        },

        /**
         * Закрытие процесса: перевод в «Завершено».
         *
         * Отдельного метода «закрыть» у ERP нет — закрытие это переход в
         * финальный статус. Но переход не всегда прямой: у типа «1 Линия /
         * Обращение абонента» из «Новый» (1) сразу в «Завершено» (4) биллинг
         * отвечает «Переход со статуса 1 на статус 4 невозможен». Свежесозданное
         * обращение всегда в «Новый», поэтому идём через «В работе» (2):
         * проверено на живом процессе — 1 → 2 → 4 проходит.
         *
         * Сначала пробуем прямой переход: если администратор разрешил 1 → 4,
         * лишний шаг не нужен. Не вышло — идём через промежуточный статус.
         */
        async closeProcess(processId, comment) {
            const pid = processId || '';
            if (!pid) return { ok: false, message: 'нет ID процесса' };

            const setStatus = async (statusId) => {
                const body = new URLSearchParams({
                    id: String(pid),
                    method: 'processStatusUpdate',
                    statusId: String(statusId),
                    comment: comment || '',
                });
                const res = await fetch('/user/process.do', {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body,
                });
                const text = await res.text();
                return jsonVerdict(text);
            };

            const direct = await setStatus(PROCESS_STATUS_DONE);
            if (direct.ok) return direct;

            // Прямой переход запрещён — поднимаем в «В работе» и закрываем оттуда
            const work = await setStatus(PROCESS_STATUS_WORK);
            if (!work.ok) {
                return { ok: false, message: direct.message || work.message || 'переход запрещён' };
            }
            return setStatus(PROCESS_STATUS_DONE);
        },

        /**
         * Процессы договора — те же, что на вкладке «Процессы» карточки.
         *
         * ERP: /user/process/link.do, method=linkedProcessList. Привязка задаётся
         * парой objectType=contract:bill + id (numeric), плюс objectTitle — номер
         * договора; без него список пустой.
         *
         * Параметр `open` — это и есть фильтр «Открытые»:
         *   1 — только открытые (закрытых нет, у них пусто в колонке «Закрыт»);
         *   0 — только закрытые;
         *   пусто — все.
         * Раньше его не передавали и получали общий список, в котором открытые
         * и завершённые шли вперемешку: оператор не мог понять, есть ли у
         * абонента незакрытое обращение.
         *
         * Колонки таблицы: Процесс | Тип | Создан | Статус | Закрыт | Роль.
         * В первой ячейке — ссылка вида «#16503 Смена ПД», из неё берём id и
         * заголовок. Возвращает { rows, total }, где total — «Записей: N»
         * из ответа (сам список ERP режет по pageSize).
         */
        async processes(cid, open) {
            const id = cid || this.contractId();
            if (!id) return { rows: [], total: 0 };

            const title = this.contractNumber(id);
            const params = new URLSearchParams({
                method: 'linkedProcessList',
                objectType: 'contract:bill',
                id: String(id),
                objectTitle: title || '',
                open: open == null ? '' : String(open),
                typeId: '',
                pageIndex: '1',
                pageSize: '25',
            });

            const html = await fetchText('/user/process/link.do?' + params.toString());
            const body = parseHtml(html);

            const rows = [];
            Array.from(body.querySelectorAll('table.data tr')).forEach((tr) => {
                const tds = Array.from(tr.querySelectorAll('td'));
                if (tds.length < 4) return; // заголовок и пустые строки
                const cells = tds.map((td) => td.innerText.replace(/\s+/g, ' ').trim());
                if (/^Процесс$/i.test(cells[0])) return;

                // «#16503 Смена ПД» → id 16503, заголовок «Смена ПД»
                const pid = (cells[0].match(/#(\d+)/) || [])[1] || '';
                const name = cells[0].replace(/^#?\d+\s*/, '').trim();

                rows.push({
                    id: pid,
                    name,
                    type: cells[1] || '',
                    created: cells[2] || '',
                    status: cells[3] || '',
                    closed: cells[4] || '',
                });
            });

            const totalMatch = html.match(/Записей:\s*<b>(\d+)<\/b>/);
            return { rows, total: totalMatch ? Number(totalMatch[1]) : rows.length };
        },

        /**
         * Ошибки Radius Logs по договору за последние 24 ч.
         *
         * Плагин ERP: /user/plugin/radius/radius.do
         *   mode=errors — вкладка «Ошибки» (не логи и не текущие сессии);
         *   contract   — номер договора (BILL…), не numeric id;
         *   period     — окна 0-1 / 1-2 / 2-4 / 4-8 / 8-24 ч (взаимоисключающие,
         *                отсчёт от текущего момента, поэтому вместе дают ровно сутки);
         *   page.pageIndex / page.pageSize — именно так ERP листает страницы
         *                (см. window.toPage). Параметры pageIndex/pageSize сервер
         *                молча игнорирует и всегда отдаёт первые 25 записей.
         *
         * Колонки таблицы: Договор | Устройство | Сервис | Время | Ошибка | Кол-во.
         */
        async radiusErrors(cid) {
            const id = cid || this.contractId();
            const title = this.contractNumber(id);
            // Без номера договора фильтр бесполезен: показали бы «ошибок нет»,
            // хотя на деле не смогли отфильтровать. Пусть блок скажет правду.
            if (!title) return { rows: [], total: 0, title: '', noContractNumber: true };

            const periods = ['0-1', '1-2', '2-4', '4-8', '8-24'];
            const pageSize = 300;
            const maxPages = 20;

            const fetchPeriod = async (period) => {
                const rows = [];
                let total = 0;

                for (let page = 1; page <= maxPages; page += 1) {
                    const url = `/user/plugin/radius/radius.do?mode=errors`
                        + `&period=${encodeURIComponent(period)}`
                        + `&contract=${encodeURIComponent(title)}`
                        + `&page.pageIndex=${page}&page.pageSize=${pageSize}`;
                    const html = await fetchText(url);
                    const body = parseHtml(html);
                    const m = html.match(/Записей:\s*<b>(\d+)<\/b>/i);
                    if (m) total = Number(m[1]) || 0;

                    const table = body.querySelector('table.data');
                    if (!table) break;

                    const trs = Array.from(table.querySelectorAll('tr')).slice(1);
                    trs.forEach((tr) => {
                        const tds = Array.from(tr.querySelectorAll('td'));
                        if (tds.length < 5) return;
                        const cells = tds.map((td) => td.innerText.replace(/\s+/g, ' ').trim());
                        if (/^Договор$/i.test(cells[0]) || /^Ошибка$/i.test(cells[4])) return;
                        const error = cells[4] || '';
                        if (!error) return;
                        // Кнопка «Лог» ведёт на полный RADIUS-обмен этого запроса
                        // (requestLog). По ней можно понять, какой пароль прислал
                        // роутер и что ответил биллинг — см. radiusRequestLog().
                        const logBtn = tr.querySelector('button.radius-log, button[data-url*="requestLog"]');
                        rows.push({
                            contract: cells[0] || title,
                            device: cells[1] || '',
                            service: cells[2] || '',
                            time: cells[3] || '',
                            error,
                            count: cells[5] || '',
                            logUrl: logBtn ? (logBtn.getAttribute('data-url') || '') : '',
                        });
                    });

                    // Страница неполная или записи кончились — дальше листать нечего
                    if (!total || trs.length < pageSize || rows.length >= total) break;
                }
                return rows;
            };

            const chunks = await Promise.all(periods.map((p) => fetchPeriod(p).catch(() => [])));
            const seen = new Set();
            const rows = [];
            chunks.flat().forEach((r) => {
                // Окна не пересекаются, но на границе час может попасть дважды
                const key = [r.time, r.error, r.device, r.service, r.count].join('|');
                if (seen.has(key)) return;
                seen.add(key);
                rows.push(r);
            });

            // Свежие сверху: dd.MM.yyyy HH:mm:ss
            const toTs = (t) => {
                const m = String(t || '').match(/(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?/);
                if (!m) return 0;
                return new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +(m[6] || 0)).getTime() || 0;
            };
            rows.sort((a, b) => toTs(b.time) - toTs(a.time));

            return { rows, total: rows.length, title };
        },

        /**
         * Полный RADIUS-обмен одного запроса (кнопка «Лог» у ошибки).
         *
         * ERP: radius.do?method=requestLog&deviceId&time&recordId
         * Отдаёт <pre> с пакетами Access-Request / Access-Accept / Access-Reject
         * и всеми атрибутами. Для ошибки «[2] Неверный пароль» это единственный
         * способ увидеть, ЧТО именно прислал роутер: в логе есть User-Name,
         * User-Password, client-mac-address и Reply-Message с кодом ответа.
         *
         * Возвращает разобранный первый Access-Request и итоговый пакет-ответ.
         */
        async radiusRequestLog(logUrl) {
            if (!logUrl) return null;
            const html = await fetchText(logUrl);
            // <pre> содержит сам лог; теги вырезаем, чтобы не зависеть от разметки.
            // Сущности декодируем обязательно: в пароле встречается «&», и без этого
            // он показывался как «eijzo&amp;» — оператор скопировал бы неверный пароль.
            const text = html
                .replace(/<[^>]+>/g, '')
                .replace(/&nbsp;/g, ' ')
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&quot;/g, '"')
                .replace(/&#39;/g, "'")
                .replace(/&amp;/g, '&');

            // Пакеты разделены строкой «Time: …»
            const chunks = text.split(/(?=^Time:\s)/m).filter((s) => /Packet type:/.test(s));
            const packets = chunks.map((chunk) => {
                const attrs = {};
                chunk.split('\n').forEach((line) => {
                    const m = line.match(/^\s{2}([A-Za-z0-9-]+)=(.+)$/);
                    if (!m) return;
                    // Одинаковые атрибуты (Cisco-SSG-Account-Info) встречаются дважды
                    if (attrs[m[1]] === undefined) attrs[m[1]] = m[2].trim();
                });
                return {
                    time: (chunk.match(/^Time:\s*(.+)$/m) || [])[1] || '',
                    type: (chunk.match(/Packet type:\s*(.+)$/m) || [])[1] || '',
                    attrs,
                };
            });

            const request = packets.find((p) => /Access-Request/i.test(p.type)) || null;
            const response = packets.find((p) => /Access-(Accept|Reject)/i.test(p.type)) || null;
            if (!request && !response) return null;

            const a = (request && request.attrs) || {};
            const r = (response && response.attrs) || {};

            return {
                requestTime: request ? request.time : '',
                userName: a['User-Name'] || '',
                password: a['User-Password'] || '',
                mac: a['Cisco-avpair']
                    ? (String(a['Cisco-avpair']).match(/client-mac-address=(\S+)/) || [])[1] || ''
                    : '',
                nasPort: a['Cisco-NAS-Port'] || a['NAS-Port-Id'] || '',
                accepted: !!(response && /Access-Accept/i.test(response.type)),
                replyCode: r['Reply-Message'] || '',
                framedIp: r['Framed-IP-Address'] || '',
            };
        },

        /** Баланс (берём последнюю строку таблицы за «весь период договора»). */
        async balance(cid) {
            const id = cid || this.contractId();
            if (!id) return null;
            const url = `/user/plugin/bgbilling/proto/balance.do?billingId=bill&contractId=${id}` +
                `&method=balance&dateFrom=01.01.2000&dateTo=${encodeURIComponent(todayRu())}`;
            const html = await fetchText(url);
            const body = parseHtml(html);

            let last = null;
            body.querySelectorAll('table.data tr').forEach((tr) => {
                const tds = Array.from(tr.querySelectorAll('td'));
                if (tds.length < 6) return;
                const month = tds[0].innerText.trim();
                // Берём последнюю строку с годом (порядок в таблице — хронологический)
                if (!/\d{4}/.test(month) || /месяц|год/i.test(month)) return;
                last = {
                    month,
                    in: tds[1].innerText.trim(),
                    payment: tds[2].innerText.trim(),
                    account: tds[3].innerText.trim(),
                    charge: tds[4].innerText.trim(),
                    out: tds[5].innerText.trim(),
                };
            });
            return last;
        },

        /**
         * Сервисы Интернета из дерева модуля: тип подключения, статус, состояние на устройстве.
         * В таблице сессий этих данных нет — берём отдельным запросом.
         * Возвращает { map: {название: {type,status,state,period}}, list: [...] }.
         */
        async services(cid) {
            const id = cid || this.contractId();
            if (!id) return { map: {}, list: [] };

            const html = await fetchText(
                `/user/plugin/bgbilling/proto/inet.do?billingId=bill&contractId=${id}&moduleId=1&method=serviceTree`
            );
            const body = parseHtml(html);

            const map = {};
            const list = [];

            body.querySelectorAll('tr').forEach((tr) => {
                const cells = Array.from(tr.querySelectorAll('td'))
                    .map((td) => td.innerText.replace(/\s+/g, ' ').trim());
                // Сервис | Тип | Период | Статус | Состояние | ID
                if (cells.length < 5) return;

                const name = cells[0];
                const type = cells[1];
                if (!name || !/^(PPPoE|IPoE|PPTP|L2TP|VLAN)$/i.test(type)) return;

                const item = {
                    name,
                    type: type.toUpperCase(),
                    period: cells[2] || '',
                    status: cells[3] || '',
                    state: cells[4] || '',
                    // ID нужен, чтобы закрыть сервис при выдаче белого IP.
                    // ERP отдаёт его отдельной колонкой (может быть в 5 или 6).
                    id: (/^\d+$/.test(cells[5] || '') ? cells[5] : '')
                        || (/^\d+$/.test(cells[4] || '') ? cells[4] : ''),
                };
                map[name.toLowerCase()] = item;
                list.push(item);
            });

            return { map, list };
        },

        /**
         * Устройства (NAS), к которым можно привязать сервис с публичным адресом.
         *
         * Только для IPoE: у PPPoE устройство задаётся в конфигурации типа сервиса
         * (const.device.id), оператор его не выбирает — документация BGBilling,
         * «Общий алгоритм настройки» (43385882).
         *
         * Для IPoE устройство обязательно, и у него должна быть настроена
         * категория IP-ресурсов (ip.resource.categoryId, 43385952), иначе
         * биллинг отвечает «Категория IP-ресурса не найдена».
         *
         * Предпочтительное устройство — BRAS Microtik BRAS-004: через него
         * выдаются публичные адреса.
         */
        async devices() {
            const PREFERRED = /BRAS-004/i;

            const url = '/user/plugin/bgbilling/proto/inet.do?method=devicesGet'
                + '&billingId=bill&moduleId=1&deviceId=0&deviceTypeIds=&deviceGroupIds=';
            const html = await fetchText(url);
            const body = parseHtml(html);

            const all = [];
            body.querySelectorAll('.item').forEach((item) => {
                const titleEl = item.querySelector(':scope > .title');
                if (!titleEl) return;
                const sel = titleEl.querySelector('[onclick*="select"]');
                const onclick = sel ? sel.getAttribute('onclick') : '';
                const m = onclick.match(/select\(this\.parentElement,\s*'(\d+)'/);
                if (!m) return;

                const id = m[1];
                const title = titleEl.textContent.replace(/\s+/g, ' ').trim();
                // Папки — это группы, у них нет адреса в квадратных скобках
                if (!/\[[\d.]+\]/.test(title)) return;
                if (id === '0') return;

                all.push({ id, title, preferred: PREFERRED.test(title) });
            });

            /*
             * Проверка «у устройства настроена категория IP-ресурсов».
             *
             * Устройства без категории биллинг отбивает ошибкой 500 «Категория
             * IP-ресурса не найдена». Браузер печатает такие ответы в консоль
             * сам, и подавить это со стороны скрипта нельзя — остаётся не
             * создавать их лишний раз.
             *
             * Раньше проверялись ВСЕ устройства при каждой отрисовке панели
             * (а панель перерисовывается при каждом возврате на вкладку), и
             * консоль заполнялась десятком 500-х. Теперь:
             *   • результат проверки запоминается на время сеанса страницы —
             *     и удачный, и неудачный: устройство не «исправится» само;
             *   • предпочтительное (BRAS-004) проверяется первым, и как только
             *     оно подошло, остальные не трогаем вовсе.
             *
             * Ошибку сессии (fetchText бросает на странице входа) НЕ глотаем:
             * иначе все устройства разом «теряли категорию» и оператор видел
             * «нет доступных устройств» вместо «войдите заново».
             */
            if (!ERP._devicesProbe) ERP._devicesProbe = new Map();
            const probe = ERP._devicesProbe;

            // BRAS-004 вперёд: обычно нужен именно он, и тогда хватит одного запроса
            const ordered = all.slice().sort((a, b) => (b.preferred ? 1 : 0) - (a.preferred ? 1 : 0));

            let sessionLost = null;
            const ok = [];
            for (let i = 0; i < ordered.length; i += 1) {
                const d = ordered[i];
                let good = probe.get(d.id);

                if (good === undefined) {
                    const u = `/user/plugin/inetip/inetip.do?method=freeIpList`
                        + `&billingId=bill&moduleId=1&typeId=2&deviceId=${encodeURIComponent(d.id)}`
                        + `&ifaceId=0&dateFrom=${encodeURIComponent(todayRu())}&dateTo=`;
                    try {
                        const t = await fetchText(u);
                        good = !/BGException|не найдена|Exception/i.test(t) && /class="inetipIp"/.test(t);
                        probe.set(d.id, good);
                    } catch (e) {
                        // Истёкшая сессия — не «нет категории», а повод перелогиниться
                        if (/Сессия ERP истекла/.test(e.message || '')) { sessionLost = e; break; }
                        probe.set(d.id, false);
                        good = false;
                    }
                }

                if (good) {
                    ok.push(d);
                    // BRAS-004 с категорией найден — остальные для работы не нужны.
                    // Проверяем это ДО перехода к следующему устройству и
                    // независимо от того, взято ли значение из кэша: иначе
                    // закэшированный BRAS-004 не останавливал перебор, и при
                    // каждой перерисовке панели шёл опрос всех остальных
                    // устройств — те самые 500-е в консоли.
                    if (d.preferred) break;
                }
            }
            if (sessionLost) throw sessionLost;

            // Предпочтительное устройство — первым
            ok.sort((a, b) => (b.preferred ? 1 : 0) - (a.preferred ? 1 : 0));
            return ok;
        },

        /**
         * Свободные IP-адреса из ресурсов биллинга, сгруппированные по категориям.
         *
         * Плагин ERP: inetip.do?method=freeIpList — это тот же список, что видит
         * оператор по кнопке «<<<» в редакторе сервиса (см. /js/pl.inetip.js).
         * Документация BGBilling: «IP-ресурсы» — категории образуют дерево,
         * статический адрес берётся из категории, указанной в ip.resource.categoryId
         * устройства (bgbilling.ru/versions/v7.2/doc/43385952.html).
         *
         * typeId: 1 = PPPoE, 2 = IPoE. Для белого IP нужен IPoE.
         * Возвращает [{ title, isWhite, ips: [...] }].
         */
        async freeIpList(cid, typeId) {
            const id = cid || this.contractId();
            if (!id) return [];

            const url = `/user/plugin/inetip/inetip.do?method=freeIpList`
                + `&billingId=bill&moduleId=1&typeId=${encodeURIComponent(typeId || 2)}`
                + `&deviceId=0&ifaceId=0&dateFrom=${encodeURIComponent(todayRu())}&dateTo=`;
            const html = await fetchText(url);
            const body = parseHtml(html);

            const out = [];
            body.querySelectorAll('.inetipTree details').forEach((det) => {
                const title = (det.querySelector('summary') || {}).textContent || '';
                const clean = title.replace(/\s+/g, ' ').trim();
                const ips = Array.from(det.querySelectorAll('.inetipIp'))
                    .map((el) => (el.dataset.ip || el.textContent || '').trim())
                    .filter(Boolean);
                if (!ips.length) return;
                out.push({
                    title: clean,
                    // «IPoE белые» — публичные адреса. По названию категории,
                    // потому что ID категорий в разметке не отдаётся.
                    isWhite: /бел|white|публичн/i.test(clean),
                    ips,
                });
            });
            return out;
        },

        /**
         * Примечания к договору (узел «Примечания» в дереве карточки BGBilling).
         *
         * Разметка ERP: таблица, где в первой ячейке кнопки «Редактировать» и
         * «Удалить». Ни ID примечания, ни тема в отдельной колонке не отдаются,
         * поэтому ID вытаскиваем из onclick кнопки редактирования, а поля читаем
         * по порядку ячеек: [0] кнопки, [1] тема, [2] текст, [3] дата, [4] автор.
         * Текст лежит в <pre class="pre-wrap"> — переносы строк в нём значимые.
         */
        async memos(cid) {
            const id = cid || this.contractId();
            if (!id) return [];

            const html = await fetchText(
                `/user/plugin/bgbilling/proto/contract.do?billingId=bill&contractId=${id}&method=memoList`
            );
            const body = parseHtml(html);

            const out = [];
            body.querySelectorAll('table.data tr').forEach((tr) => {
                const tds = Array.from(tr.querySelectorAll('td'));
                // Шапка — «Тема / Текст / Дата / Пользователь» без кнопок
                if (tds.length < 5) return;
                if (/^Тема$/i.test(tds[1].innerText.trim())) return;

                const editBtn = tds[0].querySelector('[onclick*="getMemo"]');
                const delBtn = tds[0].querySelector('[onclick*="deleteMemo"]');
                const src = (editBtn && editBtn.getAttribute('onclick'))
                    || (delBtn && delBtn.getAttribute('onclick')) || '';
                const memoId = (src.match(/[?&]id=(\d+)/) || [])[1] || '';

                const textEl = tds[2].querySelector('pre') || tds[2];
                out.push({
                    id: memoId,
                    title: tds[1].innerText.replace(/\s+/g, ' ').trim(),
                    // innerText у <pre> сохраняет переносы — берём как есть
                    text: (textEl.innerText || '').replace(/\s+$/, ''),
                    date: tds[3].innerText.replace(/\s+/g, ' ').trim(),
                    user: tds[4].innerText.replace(/\s+/g, ' ').trim(),
                });
            });

            // Свежие сверху: биллинг отдаёт в порядке добавления, а оператору
            // нужна последняя запись, а не та, что сделана месяц назад.
            out.sort((a, b) => (parseErpDate(b.date) || 0) - (parseErpDate(a.date) || 0));
            return out;
        },

        /**
         * Создание или правка примечания.
         *
         * Один и тот же метод updateMemo: пустой id — создание, заполненный —
         * правка. Ответ — JSON {"status":"ok"|"error","message":"…"}.
         */
        async memoSave(cid, memo) {
            const id = cid || this.contractId();
            const m = memo || {};
            const text = await postForm('/user/plugin/bgbilling/proto/contract.do', {
                method: 'updateMemo',
                billingId: 'bill',
                contractId: String(id),
                id: String(m.id || ''),
                title: String(m.title || ''),
                text: String(m.text || ''),
            });
            return jsonVerdict(text);
        },

        /** Удаление примечания. Ответ — тот же JSON, что у сохранения. */
        async memoDelete(cid, memoId) {
            const id = cid || this.contractId();
            const text = await postForm('/user/plugin/bgbilling/proto/contract.do', {
                method: 'deleteMemo',
                billingId: 'bill',
                contractId: String(id),
                id: String(memoId || ''),
            });
            return jsonVerdict(text);
        },

        /**
         * Тип лица по группе параметров договора BGBilling.
         *
         * ERP хранит признак в комбобоксе «Группа параметров» со значениями
         * 1 = Физик, 2 = Юрик. Это тот же переключатель, что оператор видит
         * в карточке договора, поэтому отдельный запрос не нужен — читаем
         * уже отрисованную страницу.
         */
        personType(cid) {
            const id = cid || this.contractId();
            const scope = id ? document.querySelector(`[id="bill-${id}-parameters-info"]`) || document : document;

            // Ищем комбо, в котором есть оба пункта «Физик» и «Юрик»
            const combos = Array.from(scope.querySelectorAll('.combo'));
            for (let i = 0; i < combos.length; i++) {
                const items = Array.from(combos[i].querySelectorAll('ul.drop > li'));
                const hasPhys = items.some((li) => /^Физик$/i.test(li.textContent.trim()));
                const hasLegal = items.some((li) => /^Юрик$/i.test(li.textContent.trim()));
                if (!hasPhys || !hasLegal) continue;
                const hidden = combos[i].querySelector('input[type="hidden"]');
                const val = hidden ? String(hidden.value) : '';
                if (val === '2') return 'legal';
                if (val === '1') return 'person';
            }
            return '';
        },

        /**
         * Создание сервиса в биллинге (Inet).
         *
         * Форма ERP: inetip.do, method=serviceCreate. Поля повторяют редактор
         * сервиса BGBilling: тип (1 PPPoE / 2 IPoE), логин, пароль, устройство,
         * адрес (addrFrom), период. Пустой dateTo = бессрочно.
         *
         * addrFrom/addrTo — статический адрес из ресурсов. Документация BGBilling:
         * адрес при сохранении проверяется на вхождение в ресурс
         * (bgbilling.ru/versions/v7.2/doc/43385982.html).
         */
        async createService(cid, opts) {
            const id = cid || this.contractId();
            if (!id) throw new Error('Нет ID договора');
            const o = opts || {};

            const params = new URLSearchParams({
                method: 'serviceCreate',
                contractId: String(id),
                billingId: 'bill',
                moduleId: '1',
                id: '',
                deviceTypeIds: '',
                deviceGroupIds: '',
                typeId: String(o.typeId || 2),
                data: '',
                dateFrom: o.dateFrom || todayRu(),
                dateTo: o.dateTo || '',
                status: '0',
                sessions: '0',
                login: o.login || '',
                // Без этих флагов биллинг считает, что логин задан вручную,
                // и при пустом login отвечает «Логин уже используется» —
                // пустая строка совпадает с пустым логином другого сервиса.
                generateLogin: o.login ? '0' : '1',
                pswd: o.password || '',
                generatePassword: o.password ? '0' : '1',
                deviceId: String(o.deviceId || 0),
                deviceTitle: '',
                ifaceId: '0',
                ifaceTitle: '',
                vlan: '-1',
                // MAC роутера: для IPoE это способ авторизации абонента.
                // Принимаем любой ввод и приводим к формату биллинга a4ba.7002.8a61:
                //   AA:BB:CC:DD:EE:FF, AA-BB-..., aabb.ccdd.eeff, aabbccddeeff
                macAddress: normalizeMac(o.mac),
                // Пустой адрес — не то же самое, что 0.0.0.0: биллинг пытается
                // выделить статический адрес из ресурсов и падает с «Подходящий
                // ip ресурс не найден». Для PPPoE адрес должен быть пустым.
                addrFrom: o.addr || '',
                addrTo: o.addrTo || o.addr || '',
                mask: String(o.mask || 0),
                contractObjectId: '0',
                comment: o.comment || '',
            });

            const res = await fetch(`/user/plugin/inetip/inetip.do?${params}`, {
                method: 'POST',
                credentials: 'same-origin',
            });
            const text = await res.text();
            // Сервис создан — прежние ответы ERP устарели. Без сброса панель
            // после выдачи белого IP ещё минуту показывала старое дерево
            // сервисов и прежний список свободных адресов (в нём висел только
            // что выданный адрес), потому что этот POST идёт мимо postForm().
            netDrop(/serviceTree|method=serviceGet|freeIpList|contractCards|sessionAliveContractList/i);
            return { ok: res.ok, text };
        },

        /**
         * Закрытие сервиса вчерашним числом.
         *
         * По требованиям биллинга старый сервис не удаляется, а закрывается
         * прошлой датой — тогда история и начисления остаются корректными.
         *
         * serviceUpdate требует ВСЕ поля сервиса, а не только dateTo: иначе
         * биллинг падает с «Подходящий ip ресурс не найден» (для PPPoE пустой
         * addrFrom) или сбрасывает параметры. Поэтому сначала читаем сервис,
         * затем сохраняем его с новым dateTo.
         *
         * Пароль в форме замаскирован (*******) — в этом виде его отправлять
         * нельзя, иначе он затрёт настоящий. Если маска — поле не передаём.
         */
        async closeService(cid, serviceId, dateTo) {
            const id = cid || this.contractId();
            if (!id || !serviceId) throw new Error('Нет ID договора или сервиса');

            const readUrl = `/user/plugin/bgbilling/proto/inet.do?method=serviceGet`
                + `&id=${encodeURIComponent(serviceId)}&contractId=${encodeURIComponent(id)}`
                + '&billingId=bill&moduleId=1';
            const html = await fetchText(readUrl);
            const body = parseHtml(html);
            const form = body.querySelector('form');
            if (!form) throw new Error('Сервис не найден');

            const val = (n) => {
                const el = form.elements[n];
                return el ? el.value : '';
            };

            const params = new URLSearchParams({
                method: 'serviceUpdate',
                contractId: String(id),
                billingId: 'bill',
                moduleId: '1',
                id: String(serviceId),
                typeId: val('typeId'),
                data: val('data'),
                dateFrom: val('dateFrom'),
                dateTo: dateTo || yesterdayRu(),
                // Закрываем: статус 1 = «закрыт»
                status: '1',
                sessions: val('sessions') || '0',
                login: val('login'),
                deviceId: val('deviceId'),
                deviceTitle: val('deviceTitle'),
                ifaceId: val('ifaceId') || '0',
                ifaceTitle: val('ifaceTitle'),
                vlan: val('vlan') || '-1',
                macAddress: val('macAddress'),
                // Адрес при закрытии всегда пустой — и для PPPoE, и для IPoE.
                //
                // Проверено на живом биллинге: если отправить прежний
                // addrFrom=0.0.0.0 (или любой адрес), serviceUpdate падает
                // с «Подходящий ip ресурс не найден» и сервис остаётся
                // открытым. Пустое значение биллинг принимает и освобождает
                // адрес из ресурсов — а при закрытии он и должен освободиться.
                addrFrom: '',
                addrTo: '',
                mask: val('mask') || '0',
                contractObjectId: val('contractObjectId') || '0',
                comment: val('comment'),
            });

            // Маску пароля не отправляем — иначе затрём настоящий пароль
            const pswd = val('pswd');
            if (pswd && !/^\*+$/.test(pswd)) params.set('pswd', pswd);

            const res = await fetch(`/user/plugin/bgbilling/proto/inet.do?${params}`, {
                method: 'POST',
                credentials: 'same-origin',
            });
            const text = await res.text();
            // Сервис закрыт — адрес вернулся в пул, дерево сервисов изменилось.
            // Запрос идёт мимо postForm(), поэтому кэш сбрасываем здесь.
            netDrop(/serviceTree|method=serviceGet|freeIpList|contractCards|sessionAliveContractList/i);
            return { ok: res.ok, text };
        },

        /** История статусов договора + задания на смену статуса. */
        async statusLog(cid) {
            const id = cid || this.contractId();
            if (!id) return { history: [], tasks: [], current: '' };

            const html = await fetchText(
                `/user/plugin/bgbilling/proto/contract.do?billingId=bill&contractId=${id}&method=status`
            );
            const body = parseHtml(html);

            // Колонки: Период | Статус | Комментарий
            const history = [];
            const tasks = [];
            const tables = body.querySelectorAll('table.data');

            if (tables[0]) {
                Array.from(tables[0].querySelectorAll('tr')).forEach((tr) => {
                    const tds = Array.from(tr.querySelectorAll('td')).map((td) => td.innerText.replace(/\s+/g, ' ').trim());
                    if (tds.length < 2 || /^Период$/i.test(tds[0])) return;
                    history.push({ period: tds[0], status: tds[1], comment: tds[2] || '' });
                });
            }

            // Задания на смену статуса. Реальные колонки ERP (проверено на 36160):
            //   Период | Статус | Время | Пользователь | Комментарий
            // Раньше здесь ожидались «Статус задачи» и «Создана/Создал» — таких
            // колонок нет, и в created/user попадали комментарий и пустая строка.
            if (tables[1]) {
                Array.from(tables[1].querySelectorAll('tr')).forEach((tr) => {
                    const tds = Array.from(tr.querySelectorAll('td')).map((td) => td.innerText.replace(/\s+/g, ' ').trim());
                    if (tds.length < 3 || /^Период$/i.test(tds[0])) return;
                    tasks.push({
                        period: tds[0],
                        status: tds[1] || '',
                        created: tds[2] || '',
                        user: tds[3] || '',
                        comment: tds[4] || '',
                    });
                });
            }

            const current = history.length ? history[0].status : '';
            return { history, tasks, current };
        },

        /** Платежи за период (по умолчанию — текущий год). */
        async payments(cid, dateFrom, dateTo) {
            const id = cid || this.contractId();
            if (!id) return [];

            const now = new Date();
            const p = (n) => String(n).padStart(2, '0');
            const from = dateFrom || `01.01.${now.getFullYear()}`;
            const to = dateTo || `${p(now.getDate())}.${p(now.getMonth() + 1)}.${now.getFullYear()}`;

            const html = await fetchText(
                `/user/plugin/bgbilling/proto/balance.do?billingId=bill&contractId=${id}` +
                `&method=paymentList&dateFrom=${from}&dateTo=${to}`
            );
            const body = parseHtml(html);

            const rows = [];
            Array.from(body.querySelectorAll('table.data tr')).forEach((tr) => {
                const tds = Array.from(tr.querySelectorAll('td'));
                if (tds.length < 4) return;
                const cells = tds.map((td) => td.innerText.replace(/\s+/g, ' ').trim());
                // [кнопка] | Дата | Сумма | Тип платежа | Комментарий | Время изменения | Пользователь | Действие
                const date = cells[1] || '';
                if (!/^\d{2}\.\d{2}\.\d{4}$/.test(date)) return;
                rows.push({
                    date,
                    sum: cells[2] || '',
                    type: cells[3] || '',
                    comment: cells[4] || '',
                    changed: cells[5] || '',
                    user: cells[6] || '',
                });
            });

            return rows;
        },

        /**
         * Сессии Интернета. BGBilling: sessionAliveContractList — активные, sessionLogContractList — история.
         * Возвращает разобранные строки + умеет сбрасывать сессию.
         */
        async sessions(kind, cid) {
            const id = cid || this.contractId();
            if (!id) return { rows: [], total: 0, html: '' };

            const method = kind === 'history' ? 'sessionLogContractList' : 'sessionAliveContractList';
            let url = `/user/plugin/bgbilling/proto/inet.do?billingId=bill&contractId=${id}&moduleId=1&method=${method}`;
            if (kind === 'history') {
                const now = new Date();
                const from = new Date(now.getFullYear(), now.getMonth(), 1);
                const p = (n) => String(n).padStart(2, '0');
                url += `&dateFrom=${p(from.getDate())}.${p(from.getMonth() + 1)}.${from.getFullYear()}` +
                    `&dateTo=${p(now.getDate())}.${p(now.getMonth() + 1)}.${now.getFullYear()}`;
            }

            // Сессии и дерево сервисов грузим ПАРАЛЛЕЛЬНО — иначе ждём дважды
            const [html, svcData] = await Promise.all([
                fetchText(url),
                this.services().catch(() => ({ map: {}, list: [] })),
            ]);
            const body = parseHtml(html);

            const rows = [];
            const table = body.querySelector('table.data');
            if (table) {
                // Колонки в живом ERP (проверено на карточке 36160):
                //   [0] меню действий | Устройство | IP | Начало | Окончание |
                //   Активность | Входящий, Мб | Исходящий, Мб | Статус | Состояние
                // Раньше здесь ожидались ConID/SessID/Сервис/Стоимость — таких колонок
                // в таблице нет, из-за чего каждая строка отбрасывалась по tds.length < 10
                // и список сессий всегда оставался пустым.
                const headCells = Array.from(table.querySelectorAll('tr'))
                    .map((tr) => Array.from(tr.querySelectorAll('td, th'))
                        .map((c) => c.innerText.replace(/\s+/g, ' ').trim()));

                // Индексы колонок по заголовку, а не по номеру: ERP может менять порядок
                const header = headCells.find((cells) => cells.some((c) => /^Устройство$/i.test(c))) || [];
                const col = (re, fallback) => {
                    const i = header.findIndex((c) => re.test(c));
                    return i >= 0 ? i : fallback;
                };
                const idx = {
                    device: col(/^Устройство$/i, 1),
                    ip: col(/^IP$/i, 2),
                    start: col(/^Начало$/i, 3),
                    end: col(/^Окончание$/i, 4),
                    active: col(/^Активность$/i, 5),
                    inMb: col(/^Входящий/i, 6),
                    outMb: col(/^Исходящий/i, 7),
                    status: col(/^Статус$/i, 8),
                    state: col(/^Состояние$/i, 9),
                };

                Array.from(table.querySelectorAll('tr')).forEach((tr) => {
                    const tds = Array.from(tr.querySelectorAll('td'));
                    // Первая ячейка — меню «Сбросить / Завершить»; без неё это заголовок
                    if (tds.length < 3 || tr.querySelector('th')) return;

                    const cells = tds.map((td) => td.innerText.replace(/\s+/g, ' ').trim());
                    if (/^Устройство$/i.test(cells[idx.device] || '')) return;

                    // Идентификатор соединения есть только в onclick кнопок меню —
                    // отдельной колонки ConID в таблице нет.
                    const onclick = Array.from(tr.querySelectorAll('[onclick]'))
                        .map((el) => el.getAttribute('onclick') || '').join(' ');
                    const conId = (onclick.match(/connectionId=(\d+)/) || [])[1] || '';

                    const ip = cells[idx.ip] || '';
                    // Сервис: у PPPoE в карточке договора он один, тип берём из дерева сервисов
                    const svcList = svcData.list || [];
                    const svc = svcList.length === 1 ? svcList[0] : null;

                    rows.push({
                        conId,
                        sessId: '',
                        device: cells[idx.device] || '',
                        ident: '',
                        service: ip,
                        connType: svc ? svc.type : '',
                        serviceStatus: svc ? svc.status : '',
                        serviceState: svc ? svc.state : '',
                        mac: '',
                        ip,
                        start: cells[idx.start] || '',
                        end: cells[idx.end] || '',
                        active: cells[idx.active] || '',
                        // Трафик за сессию: в ERP это две колонки, в UI показываем одной строкой
                        traffic: [cells[idx.inMb], cells[idx.outMb]].filter(Boolean).join(' / '),
                        cost: '',
                        status: cells[idx.status] || '',
                        state: cells[idx.state] || '',
                    });
                });
            }

            const totalMatch = html.match(/Записей:\s*<b>(\d+)<\/b>/);
            return { rows, total: totalMatch ? Number(totalMatch[1]) : rows.length, html };
        },

        /**
         * Закрытие сессии — те же два действия, что в меню ERP:
         *  close  > connectionClose  : PoD/CoA/SNMP на BRAS, абонента реально выкидывает.
         *  finish > connectionFinish : только закрывает запись соединения в БД (зависшая сессия).
         *
         * Возвращает { ok, already, message }.
         * BGBilling отвечает «Соединение не найдено (возможно уже завершено)» — это не сбой:
         * сессию уже закрыли (задача IPN или повторное нажатие), и цель достигнута.
         */
        async resetSession(conId, mode, cid) {
            const id = cid || this.contractId();
            if (!id) throw new Error('Нет ID договора');

            const method = mode === 'finish' ? 'connectionFinish' : 'connectionClose';
            const url = `/user/plugin/bgbilling/proto/inet.do?method=${method}` +
                `&billingId=bill&moduleId=1&contractId=${id}&connectionId=${encodeURIComponent(conId)}`;

            const res = await fetch(url, { method: 'POST', credentials: 'same-origin' });
            const resp = await res.text();
            // Сессию закрыли — список активных устарел. Раньше кэш чистился
            // только на следующем тике автообновления, и «Активные» ещё
            // несколько секунд показывали уже сброшенное соединение.
            netDrop(/sessionAliveContractList|sessionLogContractList|radius\.do/i);
            const plain = String(resp || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

            // Сессия уже закрыта — не ошибка
            if (/Соединение не найдено|уже завершено|connection not found/i.test(plain)) {
                return { ok: true, already: true, message: '' };
            }

            // Явные признаки отказа (не общее слово «error» из Java-стектрейса)
            const failed = !res.ok || /org\.bgerp\.app\.exception|BGException|Permission denied|Доступ запрещ/i.test(plain);

            // Первая строка исключения — самая информативная для оператора
            const reason = (plain.match(/BGException:\s*(.+?)(?:\s+at\s+|$)/i) || [])[1] || plain.slice(0, 200);

            return {
                ok: !failed,
                already: false,
                message: failed ? reason.trim() : '',
            };
        },

        /** Тарифные опции (скидки). */
        async tariffOptions(cid) {
            const id = cid || this.contractId();
            if (!id) return [];
            const html = await fetchText(
                `/user/plugin/bgbilling/proto/contractTariff.do?method=tariffOptionList&billingId=bill&contractId=${id}`
            );
            const body = parseHtml(html);
            const opts = [];
            const tables = body.querySelectorAll('table.data');
            if (!tables.length) return opts;
            tables[0].querySelectorAll('tr').forEach((tr) => {
                const tds = Array.from(tr.querySelectorAll('td')).filter((td) => !td.querySelector('button'));
                if (tds.length < 2) return;
                const name = tds[0].innerText.trim();
                if (!name || /^Название$/i.test(name)) return;
                opts.push({ name, from: (tds[1] ? tds[1].innerText.trim() : ''), to: (tds[2] ? tds[2].innerText.trim() : '') });
            });
            return opts;
        },

        /** Состав тарифа и скорость — из вкладки «Стоимость». */
        async cost(cid) {
            const id = cid || this.contractId();
            if (!id) return null;
            const html = await fetchText(
                `/user/plugin/dogovor/stoimost.do?billingId=bill&contractId=${id}`
            );
            const body = parseHtml(html);

            const info = { header: '', groups: [], total: null, charged: { months: [], items: [] } };

            const box = body.querySelector('.sv-box');
            if (box) info.header = box.innerText.replace(/\s+/g, ' ').trim();

            // В «Стоимости» две таблицы: состав тарифа и «Фактически начислено».
            // Вторая — это сводка по месяцам (Услуга | 2026-09 | 2026-10), в ней же
            // видны разовые услуги вроде «WIFI PLACE (4500 руб.)».
            const svTables = Array.from(body.querySelectorAll('table.sv-t'));
            const chargedTable = svTables.find((t) => {
                const head = t.querySelector('tr');
                const text = head ? head.innerText : '';
                return /\d{4}-\d{2}/.test(text);
            }) || svTables[1];

            svTables.filter((t) => t !== chargedTable).forEach((table) => {
                let group = null;
                table.querySelectorAll('tr').forEach((tr) => {
                    if (tr.classList.contains('sv-gr')) {
                        group = { name: tr.innerText.replace(/\s+/g, ' ').trim(), items: [] };
                        info.groups.push(group);
                        return;
                    }
                    if (tr.classList.contains('sv-itog')) {
                        const cells = tr.querySelectorAll('td');
                        const last = cells[cells.length - 2];
                        const price = tr.querySelectorAll('td.r');
                        info.total = {
                            label: tr.innerText.replace(/\s+/g, ' ').trim(),
                            price: price.length ? price[0].innerText.trim() : '',
                            pay: price.length > 1 ? price[1].innerText.trim() : (last ? last.innerText.trim() : ''),
                        };
                        return;
                    }
                    const tds = Array.from(tr.querySelectorAll('td'));
                    if (tds.length < 6) return;
                    const item = {
                        service: tds[0].innerText.trim(),
                        qty: tds[1].innerText.trim(),
                        price: tds[2].innerText.trim(),
                        sum: tds[3].innerText.trim(),
                        discount: tds[4].innerText.trim(),
                        pay: tds[5].innerText.trim(),
                        source: (tds[6] ? tds[6].innerText.trim() : ''),
                    };
                    if (!item.service) return;
                    if (!group) { group = { name: 'Услуги', items: [] }; info.groups.push(group); }
                    group.items.push(item);
                });
            });

            // «Фактически начислено»: Услуга | 2026-09 | 2026-10 (по сегодня)
            if (chargedTable) {
                const rows = Array.from(chargedTable.querySelectorAll('tr'));
                const head = rows.find((tr) => tr.querySelector('th'));
                if (head) {
                    info.charged.months = Array.from(head.querySelectorAll('th'))
                        .slice(1)
                        .map((th) => th.innerText.replace(/\s+/g, ' ').trim());

                    rows.forEach((tr) => {
                        if (tr === head) return;
                        const tds = Array.from(tr.querySelectorAll('td'));
                        if (!tds.length) return;
                        const name = tds[0].innerText.replace(/\s+/g, ' ').trim();
                        const cells = tds.slice(1).map((td) => td.innerText.replace(/\s+/g, ' ').trim());
                        if (!name) return;
                        if (/^Всего$/i.test(name)) {
                            info.charged.totalByMonth = cells;
                            return;
                        }
                        info.charged.items.push({ service: name, byMonth: cells });
                    });
                }
            }

            return info;
        },

        /**
         * Услуги из «Абонентской платы» (модуль Npay, moduleId=2).
         *
         * Это ежемесячные позиции, которые НЕ попадают в таблицу состава тарифа
         * на вкладке «Стоимость»: «Публичный IP-адрес», «Аренда роутера»,
         * «Предоставление порта ШПД» и т.п. Из-за этого они выглядели как
         * разовые начисления, хотя списываются каждый месяц.
         *
         * Берём ДВА источника и объединяем:
         *  1) справочник услуг — пустая форма serviceGet, в ней ERP отдаёт
         *     полный список названий в JS-массиве source. Он актуален всегда,
         *     даже если услугу с договора уже сняли (начисление за прошлый
         *     месяц осталось, и оно не должно попасть в разовые);
         *  2) фактически подключённые услуги — на случай, если в справочнике
         *     появилось что-то новое, чего мы ещё не знаем.
         *
         * Возвращает [{ name, period, closed }].
         */
        async npayServices(cid) {
            const id = cid || this.contractId();
            const out = [];
            const byKey = new Map();
            const add = (name, period) => {
                const n = String(name || '').replace(/\s+/g, ' ').trim();
                if (!n) return null;
                const k = n.toLowerCase();
                let item = byKey.get(k);
                if (!item) {
                    item = { name: n, period: '', closed: false };
                    byKey.set(k, item);
                    out.push(item);
                }
                // Период приходит только из списка подключённых — из справочника
                // его нет. Дополняем, а не пропускаем: иначе у всех услуг
                // период оставался пустым и «подключена» определить было нельзя.
                if (period) {
                    item.period = period;
                    item.closed = /-\s*\d{2}\.\d{2}\.\d{4}/.test(period);
                }
                return item;
            };

            // 1) Справочник услуг Npay
            try {
                const html = await fetchText(
                    '/user/plugin/bgbilling/proto/npay.do?method=serviceGet'
                    + `&contractId=${encodeURIComponent(id || '0')}&billingId=bill&moduleId=2`
                );
                const srcs = html.match(/const source = (\[[\s\S]*?\]);/g) || [];
                srcs.forEach((s) => {
                    try {
                        const arr = JSON.parse(s.replace('const source = ', '').replace(/;$/, ''));
                        (arr || []).forEach((o) => add(o && o.value));
                    } catch (e) { /* не наш массив */ }
                });
            } catch (e) { /* останется только список подключённых */ }

            // 2) Фактически подключённые услуги договора
            if (id) {
                try {
                    const html = await fetchText(
                        `/user/plugin/bgbilling/proto/npay.do?billingId=bill&contractId=${encodeURIComponent(id)}`
                        + '&method=serviceList&moduleId=2'
                    );
                    const body = parseHtml(html);
                    Array.from(body.querySelectorAll('table.data tr')).forEach((tr) => {
                        const tds = Array.from(tr.querySelectorAll('td'));
                        if (tds.length < 4) return;
                        const name = (tds[1].textContent || '').replace(/\s+/g, ' ').trim();
                        if (!name || /^услуга$/i.test(name)) return;
                        // «01.08.2026 - 31.10.2026» — закрыта, «26.10.2026 - » — действует
                        const period = (tds[3].textContent || '').replace(/\s+/g, ' ').trim();
                        add(name, period);
                    });
                } catch (e) { /* справочник уже собран */ }
            }

            return out;
        },


        /**
         * Пароли договора из «Полной карты» (contractCards):
         *  - пароль доступа к статистике;
         *  - пароли аккаунтов ТВ;
         *  - пароли сервисов Интернета (PPPoE/IPoE).
         * Колонки ищем по заголовкам, а не по индексам — ERP иногда меняет порядок.
         */
        async passwords(cid) {
            const id = cid || this.contractId();
            if (!id) return { stats: '', accounts: [], services: [] };

            const html = await fetchText(
                `/user/plugin/bgbilling/proto/contract.do?method=contractCards&billingId=bill&contractId=${id}`
            );
            const body = parseHtml(html);

            // Пароль доступа к статистике.
            //
            // Регулярка привязана к ЯЧЕЙКЕ, а не к «первому тексту после
            // подписи». Раньше она ловила любую подпись в пределах 120
            // символов, и при ПУСТОМ пароле захватывала следующую ячейку —
            // возвращала «Лимит:» вместо пустой строки, и этот мусор уходил
            // в письмо абоненту как «пароль личного кабинета».
            const statsMatch = html.match(
                /Пароль доступа к статистике:?\s*<\/b>\s*<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/i
            );
            const stats = statsMatch
                ? statsMatch[1].replace(/&nbsp;/g, ' ').replace(/<[^>]*>/g, '').trim()
                : '';

            /** Возвращает строки таблицы как объекты по именам колонок. */
            const readTable = (table) => {
                if (!table) return [];
                const out = [];
                let header = null;

                Array.from(table.querySelectorAll('tr')).forEach((tr) => {
                    const cells = Array.from(tr.querySelectorAll('td, th'))
                        .map((c) => c.innerText.replace(/\s+/g, ' ').trim());

                    if (!cells.length) return;

                    // Заголовок ERP рисует не <th>, а <td bgcolor> с <b> внутри.
                    // Раньше искали именно <th>/<td> со словом «Пароль» — заголовок
                    // не распознавался, header оставался null, и функция возвращала
                    // пустой список: пароли сервисов в «Доступах» не показывались.
                    if (!header) {
                        const lower = cells.map((c) => c.toLowerCase());
                        if (lower.includes('пароль') || lower.some((c) => /^сервис$/.test(c))) {
                            header = {};
                            lower.forEach((c, i) => { header[c] = i; });
                        }
                        return;
                    }

                    const pick = (name) => {
                        const i = header[name];
                        return (i === undefined ? '' : (cells[i] || '')).trim();
                    };

                    const row = {
                        name: cells[header['сервис'] === undefined ? 0 : header['сервис']] || '',
                        type: pick('тип'),
                        device: pick('устройство'),
                        period: pick('период'),
                        status: pick('статус'),
                        state: pick('состояние'),
                        password: pick('пароль'),
                    };

                    if (!row.name || /^пароль$/i.test(row.name) || /^сервис$/i.test(row.name)) return;
                    out.push(row);
                });

                return out;
            };

            /** Ищет таблицу, которая идёт сразу после заголовка-раздела («Аккаунт», «Интернет»). */
            const sectionTable = (titleRe) => {
                let found = null;
                body.querySelectorAll('b').forEach((b) => {
                    if (found) return;
                    if (!titleRe.test(b.innerText.trim())) return;
                    const tr = b.closest('tr');
                    const next = tr && tr.nextElementSibling;
                    const table = next && next.querySelector('table');
                    if (table) found = table;
                });
                return found;
            };

            const accounts = readTable(sectionTable(/^-?\s*(TV|ТВ)\b/i));
            const services = readTable(sectionTable(/^-?\s*Интернет$/i));

            return { stats, accounts, services };
        },

        /**
         * Логин и пароль для выдачи белого IP.
         *
         * Логин — номер договора (BILL0012056, AV0000001). Так его задают при
         * создании сервиса, и ровно это приходит в RADIUS как User-Name:
         * проверено на BILL0012056 — роутер шлёт «BILL0012056».
         * Номер берём из карточки договора, сервис для этого не нужен:
         * у нового договора сервиса может ещё не быть вовсе.
         *
         * Пароль — из карточки договора (contractCards), колонка «Пароль»:
         * в редакторе сервиса он замаскирован как *******, а здесь открыт.
         * Если сервиса нет, пароль пустой — тогда его сгенерирует биллинг.
         *
         * По документации BGBilling логин-пароль принадлежат сервису
         * (bgbilling.ru/versions/v7.2/doc/43385887.html), поэтому при создании
         * нового сервиса их и передаём.
         */
        async activeCredentials(cid) {
            const id = cid || this.contractId();
            if (!id) return null;

            // Логин — номер договора, он есть всегда
            const login = this.contractNumber(id);

            const pwd = await this.passwords(id).catch(() => null);
            const list = (pwd && pwd.services) || [];

            // В карточках таблица «Интернет» идёт от старых сервисов к новым,
            // поэтому нужный пароль — у САМОЙ СВЕЖЕЙ строки, а не у первой.
            // Раньше брали list[0]: это закрытый IPoE-сервис без пароля, из-за
            // чего в блоке «Белый IP» появлялось «пароль не заполнен», хотя
            // у действующего PPPoE пароль есть.
            const withPwd = list.filter((s) => (s.password || '').trim());

            // Сервис абонента — тот, чьё имя совпадает с логином (номером
            // договора). Старые тестовые записи вроде white-178-236-29-22
            // к текущему подключению отношения не имеют.
            const sameLogin = withPwd.filter((s) =>
                login && (s.name || '').toUpperCase().startsWith(String(login).toUpperCase()));

            const pool = sameLogin.length ? sameLogin : withPwd;
            // Берём последнюю (самую новую) запись с заполненным паролем
            const pick = pool.length ? pool[pool.length - 1] : null;

            return {
                login,
                password: (pick && pick.password) || '',
                type: (pick && pick.type) || '',
                serviceName: (pick && pick.name) || '',
            };
        },

        /**
         * Действующий сервис Интернета с его настройками: MAC, адрес, устройство.
         *
         * Нужно для «Убрать белый IP»: чтобы вернуть абонента на серый адрес
         * с тем же MAC, не заставляя оператора вбивать его заново. Берём
         * именно активный сервис (открытый и не удалённый), а не историю.
         *
         * Возвращает { id, typeId, type, mac, addr, deviceId } или null.
         */
        async activeInetService(cid) {
            const id = cid || this.contractId();
            if (!id) return null;

            const data = await this.services(id).catch(() => ({ list: [] }));
            const active = (data.list || []).filter((s) =>
                /IPoE|PPPoE/i.test(s.type || '') && isAliveService(s));
            if (!active.length) return null;

            // Самый свежий сервис: в дереве порядок не гарантирован, поэтому
            // выбираем по периоду, а не по позиции. От этого зависят MAC
            // и адрес при возврате абонента с белого IP на серый.
            active.sort((a, b) => toTsSafe(b.period) - toTsSafe(a.period));
            const svc = active[0];
            if (!svc || !svc.id) return null;

            try {
                const html = await fetchText(
                    `/user/plugin/bgbilling/proto/inet.do?method=serviceGet`
                    + `&id=${encodeURIComponent(svc.id)}&contractId=${encodeURIComponent(id)}`
                    + '&billingId=bill&moduleId=1'
                );
                const form = parseHtml(html).querySelector('form');
                const val = (n) => {
                    const el = form && form.elements[n];
                    return el ? String(el.value || '') : '';
                };
                const mac = val('macAddress');
                return {
                    id: svc.id,
                    typeId: val('typeId') || (svc.type === 'IPoE' ? '2' : '1'),
                    type: svc.type || '',
                    mac: /^\*+$/.test(mac) ? '' : mac,
                    addr: val('addrFrom'),
                    deviceId: val('deviceId'),
                };
            } catch (e) {
                return { id: svc.id, typeId: svc.type === 'IPoE' ? '2' : '1', type: svc.type || '', mac: '', addr: '', deviceId: '' };
            }
        },

        /**
         * Текущий лимит + лог изменений + задания на автоматическую смену.
         * BGBilling: лимит — минимальный остаток; должник = остаток < лимита.
         */
        async limitInfo(cid) {
            const id = cid || this.contractId();
            if (!id) return { limit: null, log: [], tasks: [] };

            const html = await fetchText(
                `/user/plugin/bgbilling/proto/contract.do?billingId=bill&contractId=${id}&method=limit`
            );
            const body = parseHtml(html);

            // Значение лимита в скрипте страницы: $('#treeTable td#limit').text('0.0')
            let limit = null;
            const m = html.match(/td#limit'\)\.text\(\s*'([^']+)'/);
            if (m) limit = m[1];
            if (limit == null) {
                // Запасной путь — только своя карточка. Раньше запрос шёл по
                // всему документу и при нескольких открытых договорах брал
                // лимит первого из них.
                const card = document.querySelector(`#content > div#contract_bill-${id}`);
                const cell = card ? card.querySelector('#treeTable td#limit') : null;
                limit = cell ? cell.innerText.trim() : null;
            }

            // Лог изменений: Время | Пользователь | Лимит | Дней | Комментарий
            const log = [];
            const tasks = [];
            const tables = body.querySelectorAll('table.data');
            if (tables[0]) {
                Array.from(tables[0].querySelectorAll('tr')).forEach((tr) => {
                    const tds = Array.from(tr.querySelectorAll('td')).map((td) => td.textContent.trim());
                    if (tds.length < 4 || /^Время$/i.test(tds[0])) return;
                    log.push({ time: tds[0], user: tds[1], limit: tds[2], days: tds[3], comment: tds[4] || '' });
                });
            }
            // Задания на автоматическую смену лимита
            if (tables[1]) {
                Array.from(tables[1].querySelectorAll('tr')).forEach((tr) => {
                    const tds = Array.from(tr.querySelectorAll('td')).map((td) => td.textContent.trim());
                    if (tds.length < 4 || /^Дата$/i.test(tds[1])) return;
                    tasks.push({ date: tds[1], status: tds[2], user: tds[3], change: tds[4] || '' });
                });
            }

            return { limit, log, tasks };
        },

        /** Фактически начислено по месяцам (последние месяцы). */
    };

    /**
     * Кэш «тяжёлых» чтений на время одной отрисовки панели.
     *
     * hydrate() запрашивает одни и те же ручки из разных блоков: balance.do —
     * для баланса, для «остатка за период» и для доверительного платежа;
     * serviceTree — для сессий, «Белого IP», «Сервисов» и закрытия сервиса;
     * stoimost.do — для абонплаты и для состава тарифа.
     *
     * Раньше каждый блок заказывал свою копию, и на открытие договора уходило
     * до тридцати запросов, из них половина — дубли. Обёртка склеивает вызовы
     * по ключу «ручка + договор» до ближайшей перерисовки панели
     * (applyContent сбрасывает panel._tpOnce).
     */
    const erpOnce = (panel, key, fn) => {
        if (!panel) return Promise.resolve().then(fn);
        const cache = panel._tpOnce || (panel._tpOnce = new Map());
        if (cache.has(key)) return cache.get(key);
        const promise = Promise.resolve().then(fn);
        cache.set(key, promise);
        return promise;
    };

    /* ------------------------------------------------------------ UI helpers */

    /**
     * Стили панели — один <style> на страницу.
     *
     * Раньше блок CSS лежал прямо в разметке панели (`<style>…</style>` внутри
     * tp-wrap), то есть при каждой перерисовке договора браузер заново
     * разбирал и применял тридцать с лишним килобайт правил. Теперь стили
     * вставляются один раз, а при перерисовке меняется только содержимое.
     */
    function injectStyle() {
        if (document.getElementById('tp-info-style')) return;
        const host = document.head || document.documentElement;
        if (!host) return;
        const el = document.createElement('style');
        el.id = 'tp-info-style';
        el.textContent = style;
        host.appendChild(el);
    }

    /**
     * Запись HTML только при изменении.
     *
     * Автообновление перерисовывало списки сессий и ошибок каждые 7 секунд,
     * даже если данные не изменились: браузер выбрасывал старые узлы, строил
     * новые, заново применял стили, и список мигал. Сравнение с предыдущей
     * строкой убирает эту работу целиком — а данных за 7 секунд обычно не
     * прибавляется.
     */
    function setHtmlIfChanged(el, html) {
        if (!el) return false;
        const next = String(html == null ? '' : html);
        if (el.__tpHtml === next) return false;
        el.__tpHtml = next;
        el.innerHTML = next;
        return true;
    }

    const style = `
        .tp-wrap {
            --tp-fg: #1d1d1f;
            --tp-fg2: rgba(29,29,31,.62);
            --tp-fg3: rgba(29,29,31,.58);
            --tp-card: rgba(255,255,255,.72);
            --tp-border: rgba(0,0,0,.07);
            --tp-shadow: 0 1px 2px rgba(0,0,0,.04), 0 8px 24px -12px rgba(0,0,0,.18);
            --tp-green: #34c759;
            --tp-red: #ff3b30;
            --tp-orange: #ff9500;
            --tp-blue: #007aff;

            /* Смысловые цвета состояний. Раньше каждый оттенок успеха был
               прописан отдельно (#1f8f42, #1f8f3d, #5fe07f, #6ee7a0), и они
               уже расходились между блоками. Теперь одна пара на состояние:
               фон плашки и цвет текста на ней. */
            --tp-ok: #1f8f42;
            --tp-ok-bg: rgba(31,143,66,.12);
            --tp-warn: #9a6400;
            --tp-warn-bg: rgba(255,149,0,.14);
            --tp-bad: #c0392b;
            --tp-bad-bg: rgba(255,59,48,.12);

            /* Три уровня нейтральной заливки вместо десяти разных альф. */
            --tp-fill-1: rgba(0,0,0,.04);
            --tp-fill-2: rgba(0,0,0,.07);
            --tp-fill-3: rgba(0,0,0,.10);

            /* Шкала радиусов: было восемь значений от 5 до 18 px. */
            --tp-radius-sm: 8px;
            --tp-radius-md: 12px;
            --tp-radius-lg: 16px;
            --tp-radius-pill: 999px;

            --tp-font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;

            font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Inter, system-ui, sans-serif;
            font-size: 14px;
            line-height: 1.45;
            color: var(--tp-fg);
            -webkit-font-smoothing: antialiased;
            padding: 18px 22px 28px;
            width: 100%;
            box-sizing: border-box;
            /* Фон панели — только холодные оттенки синего, в тон акцента ERP.
               Второй градиент раньше был зелёным (rgba(52,199,89,.05)): он
               ложился поверх тёмно-синей подложки и весь правый верхний угол
               отдавал зеленцой, а сквозь полупрозрачные карточки зеленца
               проступала и внутри них. Зелёный в интерфейсе оставлен только
               смысловым индикаторам (онлайн, успех), а не декору. */
            background:
                radial-gradient(1200px 300px at 0% -10%, rgba(0,122,255,.06), transparent 60%),
                radial-gradient(900px 260px at 100% 0%, rgba(0,122,255,.035), transparent 55%);
            border-radius: 18px;
        }
        /* Тёмная палитра общая для dark и modern-dark.
           В ERP четыре темы, и modern-dark раньше не покрывалась: панель
           получала светлые карточки (rgba(255,255,255,.72)) и чёрный текст
           поверх тёмного фона ERP — «светлый остров» посреди тёмного экрана. */
        html[data-theme="dark"] .tp-wrap,
        html[data-theme="modern-dark"] .tp-wrap {
            --tp-fg: #f5f5f7;
            --tp-fg2: rgba(245,245,247,.62);
            --tp-fg3: rgba(245,245,247,.52);
            --tp-card: rgba(28,28,30,.62);
            --tp-border: rgba(255,255,255,.09);
            --tp-shadow: 0 1px 2px rgba(0,0,0,.5), 0 12px 32px -16px rgba(0,0,0,.8);
            --tp-ok: #5fe07f;
            --tp-ok-bg: rgba(95,224,127,.14);
            --tp-warn: #ffb340;
            --tp-warn-bg: rgba(255,179,64,.14);
            --tp-bad: #ff6961;
            --tp-bad-bg: rgba(255,105,97,.14);
            --tp-fill-1: rgba(255,255,255,.05);
            --tp-fill-2: rgba(255,255,255,.08);
            --tp-fill-3: rgba(255,255,255,.12);
        }

        .tp-wrap * { box-sizing: border-box; }

        /* ---- grid раскладка: три колонки по зонам ответственности */
        .tp-layout { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr); gap: 14px; align-items: start; }
        /* абонент | действия | техника: левой колонке нужно больше места —
           длинные ФИО, адреса и таблица начислений */
        .tp-layout.tp-layout-3 {
            grid-template-columns: minmax(0, 1.3fr) minmax(0, 0.85fr) minmax(0, 1fr);
        }
        /* Средняя колонка узкая: «Дней» + кнопка в одну строку, расчёт — подписью.
           Поля «Сумма» и «Комментарий» убраны: сумму считает биллинг,
           комментарий постоянный. */
        .tp-col-actions .tp-field { gap: 3px; }
        .tp-col-actions .tp-field input { max-width: none; padding: 6px 10px; }
        .tp-col-actions .tp-btn { text-align: center; padding: 8px 14px; }
        .tp-col-actions .tp-msg { display: block; margin-top: 6px; }
        /* «Как посчитано» — справочная деталь, не должна раздувать карточку */
        .tp-col-actions .tp-trust-inner .tp-hint { margin-top: 8px; font-size: 11.5px; }
        @media (max-width: 1320px) {
            .tp-layout.tp-layout-3 { grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr); }
            /* на две колонки: действия уходят под технику, во всю ширину */
            .tp-col-actions { grid-column: 1 / -1; }
            /* места больше — «Дней» можно оставить узким, кнопка растянется */
            .tp-col-actions .tp-trust-days { flex: 0 0 90px; }
        }
        .tp-col { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
        @media (max-width: 980px) {
            .tp-layout { grid-template-columns: 1fr; }
            .tp-col-actions { grid-column: auto; }
        }

        .tp-card {
            background: var(--tp-card);
            border: 1px solid var(--tp-border);
            border-radius: 16px;
            box-shadow: var(--tp-shadow);
            padding: 16px 18px;
            min-width: 0;
            /* Изоляция раскладки и стилей: правка одного блока не заставляет
               браузер пересчитывать геометрию всей панели из двенадцати карточек. */
            contain: layout style;
        }

        .tp-card-title {
            display: flex; align-items: center; gap: 8px;
            font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase;
            color: var(--tp-fg3); margin: 0 0 12px;
        }
        .tp-card-title .tp-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--tp-blue); }

        /* ---- сворачиваемые карточки: <details> внутри .tp-card */
        .tp-fold { padding: 0; }
        .tp-fold > details > summary.tp-card-title {
            margin: 0; padding: 16px 18px; cursor: pointer;
            list-style: none; user-select: none;
        }
        .tp-fold > details > summary.tp-card-title::-webkit-details-marker { display: none; }
        .tp-fold > details > summary.tp-card-title:hover { color: var(--tp-fg2); }
        .tp-fold-caret {
            margin-left: auto; width: 7px; height: 7px; flex: 0 0 auto;
            border-right: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor;
            transform: rotate(-45deg); transition: transform .18s ease;
        }
        .tp-fold > details[open] > summary.tp-card-title .tp-fold-caret { transform: rotate(45deg); }
        .tp-fold > details > .tp-lazy-body { padding: 0 18px 16px; }
        /* «Абонент и тариф»: строки абонента идут сразу под шапкой */
        .tp-client-tariff > .tp-lazy-body { margin-top: 12px; }

        /* ---- шапка абонента: ФИО крупно, номер договора рядом */
        .tp-client-head {
            display: flex; align-items: baseline; justify-content: space-between;
            gap: 12px; flex-wrap: wrap;
            margin: 0 0 14px; padding-bottom: 12px;
            border-bottom: 1px solid var(--tp-border);
        }
        .tp-client-fio {
            font-size: 16px; font-weight: 650; letter-spacing: -.015em;
            color: var(--tp-fg); line-height: 1.3; min-width: 0;
        }
        .tp-client-contract {
            font-size: 11.5px; font-weight: 600; letter-spacing: .02em;
            color: var(--tp-fg3); white-space: nowrap;
            font-variant-numeric: tabular-nums;
        }
        /* Статус в шапке: заметный, но не перетягивает внимание с ФИО.
           Чуть крупнее обычных плашек — это ключевая информация о договоре,
           и на «Заморозке» она должна бросаться в глаза сразу.
           margin-left:auto прижимает плашку к правому краю, оставляя ФИО и
           номер договора рядом слева: иначе space-between растянул бы три
           элемента и номер уехал бы в середину. */
        .tp-client-status {
            padding: 3px 10px; font-size: 11.5px; font-weight: 650;
            letter-spacing: .01em; margin-left: auto;
        }
        /* ---- группы полей абонента */
        .tp-client-group + .tp-client-group { margin-top: 12px; }
        .tp-client-group-title {
            font-size: 10.5px; font-weight: 650; letter-spacing: .06em;
            text-transform: uppercase; color: var(--tp-fg3);
            margin-bottom: 2px;
        }
        .tp-client-group .tp-rows { grid-template-columns: minmax(96px, 150px) minmax(0, 1fr); }
        /* баланс — секция внутри той же карточки, с тем же разделителем, что у тарифа */
        .tp-balance-sect { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--tp-border); }
        .tp-balance-sect .tp-lazy-body { margin-top: 0; }
        .tp-balance { display: flex; flex-direction: column; gap: 8px; }
        .tp-balance-month { font-size: 11.5px; color: var(--tp-fg3); font-variant-numeric: tabular-nums; }
        .tp-balance-out {
            display: flex; align-items: baseline; justify-content: space-between; gap: 12px;
            font-size: 12.5px; color: var(--tp-fg2);
        }
        .tp-balance-out b {
            font-size: 15px; font-weight: 680; color: var(--tp-fg);
            font-variant-numeric: tabular-nums; letter-spacing: -.01em;
        }
        .tp-balance-rows { display: flex; flex-direction: column; }
        .tp-balance-row {
            display: flex; align-items: baseline; justify-content: space-between; gap: 12px;
            padding: 5px 0; font-size: 12px; color: var(--tp-fg3);
            border-top: 1px solid var(--tp-border);
        }
        .tp-balance-row b {
            font-weight: 550; color: var(--tp-fg2);
            font-variant-numeric: tabular-nums; white-space: nowrap;
        }
        .tp-balance-row.is-empty { color: var(--tp-fg3); font-size: 11.5px; border-top: 0; padding-top: 0; }

        /* ---- статус: минимализм — состояние + две цифры */
        /* денежный блок внутри карточки действий */
        .tp-money { display: flex; flex-direction: column; gap: 12px; }
        /* статус онлайна в шапке «Сессии» — данные самой сессии, а не отдельный блок */
        .tp-sess-state {
            font-size: 10.5px; font-weight: 600; letter-spacing: .02em;
            padding: 2px 8px; border-radius: var(--tp-radius-pill); margin-left: 2px;
            background: var(--tp-fill-2); color: var(--tp-fg2);
        }
        /* До прихода сессий плашка пустая — иначе в шапке висит серый
           прямоугольник ~16px. У соседних счётчиков это правило уже было. */
        .tp-sess-state:empty { display: none; }
        .tp-sess-state.is-on { background: var(--tp-ok-bg); color: var(--tp-ok); }
        .tp-sess-state.is-off { background: var(--tp-warn-bg); color: var(--tp-warn); }
        /* доступы внутри карточки «Сессия» */
        .tp-access { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--tp-border); }
        .tp-access-title {
            font-size: 10.5px; font-weight: 650; letter-spacing: .06em;
            text-transform: uppercase; color: var(--tp-fg3); margin-bottom: 4px;
        }
        .tp-pwd-state {
            font-size: 10px; font-weight: 600; color: var(--tp-fg3);
            padding: 1px 6px; border-radius: 999px; background: rgba(127,127,127,.13);
            white-space: nowrap;
        }

        /* ---- вердикт по балансу: крупная сумма + факты */
        .tp-verdict-head { display: flex; align-items: center; gap: 8px; padding-top: 2px; }
        .tp-verdict-label { font-size: 12.5px; font-weight: 600; }
        .tp-verdict-head.is-ok  .tp-verdict-label { color: var(--tp-ok); }
        .tp-verdict-head.is-bad .tp-verdict-label { color: var(--tp-bad); }
        .tp-verdict-head.is-warn .tp-verdict-label { color: var(--tp-warn); }

        .tp-verdict { display: flex; flex-direction: column; gap: 2px; padding: 6px 0 12px; }
        .tp-verdict-value {
            font-size: 30px; line-height: 34px; font-weight: 650; letter-spacing: -.02em;
            font-variant-numeric: tabular-nums;
        }
        .tp-verdict-value.is-ok { color: var(--tp-ok); }
        .tp-verdict-value.is-bad { color: var(--tp-bad); }
        .tp-verdict-value.is-warn { color: var(--tp-fg3); }
        .tp-verdict-caption { font-size: 12px; color: var(--tp-fg3); }
        .tp-verdict-skel {
            display: block; width: 110px; height: 30px; border-radius: 6px;
            background: linear-gradient(90deg, rgba(127,127,127,.12), rgba(127,127,127,.22), rgba(127,127,127,.12));
            background-size: 200% 100%;
            animation: tpShimmer 1.4s ease-in-out infinite;
        }

        .tp-facts {
            display: grid; grid-template-columns: 1fr auto; gap: 6px 12px;
            margin: 0; padding-top: 12px; border-top: 1px solid var(--tp-border);
            font-size: 12.5px;
        }
        .tp-facts dt { color: var(--tp-fg3); }
        .tp-facts dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; }
        .tp-facts dd.is-neg { color: var(--tp-bad); }

        .tp-forecast {
            margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--tp-border);
            font-size: 12px; color: var(--tp-fg2);
        }
        .tp-forecast b { color: var(--tp-fg); font-weight: 600; }
        .tp-forecast.is-warn { color: var(--tp-warn); }
        .tp-forecast.is-warn b { color: var(--tp-warn); }

        /* Пустая панель «Для ТП» (только что создана, контент ещё не вставлен)
           не должна показываться при открытии договора — иначе мелькает
           белый прямоугольник вкладки на секунду. */
        .ui-tabs-panel[id^="contract-tp-info-"]:empty { display: none; }

        /* Кнопка обновления у вкладки «Для ТП» — полностью на классах ERP.
           ERP объявляет:
             button.refreshButton-hidden { display: none; }
             button.refreshButton        { float: right; display: inline-block; }
           и переключает их при активации вкладки. Мы повторяем ту же механику
           на своём tp-refresh-hidden, не используя класс refreshButton:
           по нему ERP находит свою кнопку и добавляет вторую.
           Собственного оформления не задаём — вид целиком дают
           btn-white-hover и btn-small, как у соседних вкладок. */
        .ui-tabs-nav > li > button.tp-refresh { float: right; display: inline-block; }
        .ui-tabs-nav > li > button.tp-refresh.tp-refresh-hidden { display: none; }
        .ui-tabs-nav > li > button.tp-refresh.is-busy { pointer-events: none; }
        .ui-tabs-nav > li > button.tp-refresh.is-busy .ti-reload { animation: tpSpin .8s linear infinite; }
        @keyframes tpSpin { to { transform: rotate(360deg); } }

        /*
         * Пульсирующий индикатор: зелёный — онлайн, красный — нет связи.
         *
         * Раньше пульсация была анимацией box-shadow: тень раздувалась от 0
         * до 10px и обратно. box-shadow нельзя отдать композитору — браузер
         * каждый кадр пересчитывал и ПЕРЕРИСОВЫВАЛ элемент (paint), а вместе
         * с ним область вокруг. Три таких индикатора крутятся всегда, пока
         * открыт договор, то есть это была единственная непрерывная работа
         * на странице.
         *
         * Теперь пульсирует псевдоэлемент через transform + opacity: оба
         * свойства анимируются на GPU, без пересчёта стилей и перерисовки.
         * Выглядит так же, стоит — ноль.
         */
        .tp-signal {
            position: relative; flex: 0 0 auto;
            width: 9px; height: 9px; border-radius: 50%;
        }
        .tp-signal::after {
            content: ''; position: absolute; inset: 0; border-radius: 50%;
            background: currentColor; opacity: 0;
            animation: tpRing 2s ease-out infinite;
        }
        .tp-signal.is-ok   { background: var(--tp-green);  color: var(--tp-green); }
        .tp-signal.is-bad  { background: var(--tp-red);    color: var(--tp-red); }
        .tp-signal.is-warn { background: var(--tp-orange); color: var(--tp-orange); }
        .tp-signal.is-bad::after  { animation-duration: 1.1s; }
        .tp-signal.is-warn::after { animation-duration: 1.6s; }
        @keyframes tpRing {
            0%   { transform: scale(1);   opacity: .55; }
            70%  { transform: scale(2.4); opacity: 0; }
            100% { transform: scale(2.4); opacity: 0; }
        }

        .tp-badge {
            display: inline-flex; align-items: center; gap: 6px;
            font-size: 11px; font-weight: 600; letter-spacing: .02em;
            padding: 3px 9px; border-radius: 999px; white-space: nowrap;
        }
        .tp-badge.is-ok  { background: var(--tp-ok-bg);   color: var(--tp-ok); }
        .tp-badge.is-bad { background: var(--tp-bad-bg);  color: var(--tp-bad); }
        .tp-badge.is-warn{ background: var(--tp-warn-bg); color: var(--tp-warn); }
        .tp-badge::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }

        /* ---- строки ключ/значение */
        .tp-rows { display: grid; grid-template-columns: minmax(120px, 168px) minmax(0, 1fr); column-gap: 16px; row-gap: 0; }
        .tp-rows dt, .tp-rows dd { padding: 7px 0; margin: 0; border-bottom: 1px solid var(--tp-border); min-width: 0; }
        .tp-rows dt { color: var(--tp-fg2); font-weight: 450; }
        .tp-rows dd { font-weight: 500; word-break: break-word; }
        .tp-rows > :nth-last-child(-n+2) { border-bottom: 0; }

        /* ---- таблицы */
        .tp-table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
        .tp-table td { padding: 8px 10px 8px 0; border-bottom: 1px solid var(--tp-border); vertical-align: top; }
        .tp-table tr:last-child td { border-bottom: 0; }

        /* ---- тариф-чипы */
        .tp-plan { font-size: 16px; font-weight: 650; letter-spacing: -.01em; margin-bottom: 2px; }
        .tp-chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0 2px; }
        .tp-chip {
            font-size: 12px; font-weight: 500; padding: 4px 10px; border-radius: 999px;
            background: rgba(127,127,127,.12); color: var(--tp-fg2); white-space: nowrap;
        }
        .tp-price { display: flex; align-items: baseline; gap: 8px; margin-top: 12px; }
        .tp-price .tp-main { font-size: 22px; font-weight: 650; letter-spacing: -.02em; }
        .tp-price .tp-old { font-size: 13px; color: var(--tp-fg3); text-decoration: line-through; }
        .tp-price .tp-per { font-size: 12px; color: var(--tp-fg3); }

        /* ---- тариф: шапка и секции */
        .tp-tariff-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
        .tp-sect { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--tp-border); }
        .tp-sect-head {
            display: flex; align-items: baseline; justify-content: space-between; gap: 10px;
            font-size: 12px; font-weight: 600; color: var(--tp-fg3);
            text-transform: uppercase; letter-spacing: .03em; margin-bottom: 8px;
        }
        .tp-sect-count { font-weight: 500; text-transform: none; letter-spacing: 0; }

        /* ---- за что платит абонент */
        .tp-pay { display: flex; flex-direction: column; }
        .tp-pay-row {
            display: flex; align-items: baseline; justify-content: space-between; gap: 12px;
            padding: 7px 0; border-bottom: 1px solid var(--tp-border); font-size: 13px;
        }
        .tp-pay-row:last-child { border-bottom: 0; }
        .tp-pay-row.is-free .tp-pay-sum { color: var(--tp-fg3); }
        .tp-pay-name { color: var(--tp-fg); min-width: 0; }
        .tp-pay-sum { font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
        .tp-period-total {
            display: flex; align-items: baseline; justify-content: space-between; gap: 12px;
            margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--tp-border);
            font-size: 13px; color: var(--tp-fg3);
        }
        .tp-period-total b { font-size: 14px; color: var(--tp-fg); font-variant-numeric: tabular-nums; }

        /* ---- оборудование */
        .tp-device { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--tp-border); }
        .tp-device:last-child { border-bottom: 0; }
        .tp-device-icon {
            width: 34px; height: 34px; border-radius: 10px; flex: 0 0 auto;
            background: rgba(0,122,255,.12); display: grid; place-items: center; font-size: 15px;
        }
        .tp-device-main { min-width: 0; flex: 1 1 auto; }
        .tp-device-name { font-weight: 600; display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
        .tp-device-meta { font-size: 12px; color: var(--tp-fg2); }
        /* Копируемый фрагмент: адрес OLT и подобное.
           Снаружи ничем не выделен — ни подчёркиванием, ни подсветкой при
           клике. Оператору нужно «нажал — уже в буфере», а пунктир и синее
           выделение текста только отвлекали от строки. О кликабельности
           говорят курсор-рука и подсказка title. */
        .tp-copy {
            position: relative; cursor: pointer; user-select: none;
        }
        /* Подтверждение копирования: значение на 900 мс меняется на
           «Скопировано: 94.241». Отдельную плашку поверх строки не рисуем —
           она перекрывала соседние данные (в блоке ONU это уровни сигнала
           и телеметрия), а вставка текста на месте значения ничего не
           закрывает и сразу показывает, что именно попало в буфер. */
        .tp-copy.is-copied { color: var(--tp-ok); }
        .tp-mono { font-variant-numeric: tabular-nums; letter-spacing: .01em; }
        .tp-eq-group {
            font-size: 10.5px; font-weight: 650; letter-spacing: .07em; text-transform: uppercase;
            color: var(--tp-fg3); padding: 10px 0 2px;
        }
        .tp-eq-group:first-child { padding-top: 0; }
        .tp-eq-chips { margin: 7px 0 0; gap: 5px; }
        /* Уровни сигнала: зелёный — норма, оранжевый — на грани, красный — плохо */
        .tp-chip.is-good { background: var(--tp-ok-bg);   color: var(--tp-ok); }
        .tp-chip.is-warn { background: var(--tp-warn-bg); color: var(--tp-warn); }
        .tp-chip.is-bad  { background: var(--tp-bad-bg);  color: var(--tp-bad); }

        /* ---- ошибки Radius Logs */
        .tp-err-row {
            display: grid; grid-template-columns: 1fr auto; gap: 6px 10px;
            padding: 8px 0; border-bottom: 1px solid var(--tp-border);
            align-items: start;
        }
        .tp-err-row:last-child { border-bottom: 0; }
        .tp-err-msg {
            font-size: 12.5px; font-weight: 600; color: var(--tp-red);
            line-height: 1.35; word-break: break-word;
        }
        .tp-err-meta { font-size: 11.5px; color: var(--tp-fg3); line-height: 1.35; grid-column: 1 / -1; }
        .tp-err-count {
            font-size: 11.5px; font-weight: 650; font-variant-numeric: tabular-nums;
            color: var(--tp-fg2); white-space: nowrap; padding-top: 1px;
        }
        /* ---- inline-блок RADIUS-лога: MAC, порт и оба пароля под строкой ошибки */
        .tp-err-inline {
            grid-column: 1 / -1;
            margin-top: 6px; padding: 7px 10px; border-radius: 8px;
            background: rgba(127,127,127,.07);
            border-left: 2px solid var(--tp-border);
        }
        .tp-err-inline .tp-radlog-row { padding: 2px 0; }
        .tp-err-inline .tp-radlog-hint { margin-top: 6px; padding-top: 6px; border-top: 0; }
        .tp-err-inline .tp-pwd-val { cursor: pointer; }
        /* ---- группы ошибок подключения: одна причина — одна строка */
        .tp-errgroup { padding: 9px 0; border-bottom: 1px solid var(--tp-border); }
        .tp-errgroup:last-child { border-bottom: 0; }
        .tp-errgroup-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
        .tp-errgroup-main { min-width: 0; }
        .tp-errgroup-title { font-size: 12.5px; font-weight: 650; color: var(--tp-fg); line-height: 1.35; }
        .tp-errgroup-meta { font-size: 11px; color: var(--tp-fg3); margin-top: 2px; }
        .tp-errgroup-count {
            flex: 0 0 auto; min-width: 20px; height: 20px; padding: 0 6px;
            display: inline-flex; align-items: center; justify-content: center;
            border-radius: 10px; font-size: 11px; font-weight: 700;
            background: rgba(255,59,48,.14); color: var(--tp-red);
            font-variant-numeric: tabular-nums;
        }
        .tp-errgroup-hint {
            margin-top: 6px; font-size: 11.5px; line-height: 1.45; color: var(--tp-fg2);
            padding-left: 9px; border-left: 2px solid var(--tp-border);
        }
        .tp-errgroup-body { margin-top: 6px; padding-left: 2px; }
        .tp-errgroup-body .tp-err-row { padding: 6px 0; }
        .tp-err-body[hidden] { display: none; }
        .tp-sess-body[hidden] { display: none; }
        /* строки inline-блока: ключ слева, значение справа */
        .tp-radlog-row {
            display: flex; align-items: baseline; justify-content: space-between; gap: 12px;
            padding: 3px 0; font-size: 12px; color: var(--tp-fg2);
        }
        .tp-radlog-row b { font-weight: 600; color: var(--tp-fg); font-variant-numeric: tabular-nums; }
        .tp-radlog-row.is-ok b { color: var(--tp-ok); }
        .tp-radlog-row.is-bad b { color: var(--tp-bad); }

        .tp-radlog-hint {
            margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--tp-border);
            font-size: 11.5px; line-height: 1.45; color: var(--tp-fg2);
        }
        .tp-radlog-hint.is-ok { color: var(--tp-ok); }
        .tp-radlog-hint.is-bad { color: var(--tp-bad); }

        /* ---- белый IP */
        .tp-whiteip-current {
            margin-left: auto; font-size: 11px; font-weight: 650;
            color: var(--tp-fg2); font-variant-numeric: tabular-nums;
        }
        /* Состояние подключения: белый/серый адрес + услуга в абонплате */
        .tp-whiteip-status {
            display: flex; flex-direction: column; gap: 6px; margin-bottom: 10px;
            padding-bottom: 10px; border-bottom: 1px solid var(--tp-border);
        }
        .tp-whiteip-state {
            display: inline-flex; align-items: center; gap: 7px;
            font-size: 12px; font-weight: 600; line-height: 1.3;
        }
        /* Точка перед текстом — цвет несёт смысл, читать текст не обязательно */
        .tp-whiteip-state::before {
            content: ''; flex: 0 0 auto;
            width: 7px; height: 7px; border-radius: 50%;
            background: var(--tp-fg3);
        }
        .tp-whiteip-state.is-white::before { background: #2b8dff; }
        .tp-whiteip-state.is-grey::before { background: var(--tp-warn); }
        .tp-whiteip-state.is-none::before { background: var(--tp-fg3); }
        .tp-whiteip-state.is-ok::before { background: var(--tp-ok); }
        .tp-whiteip-state.is-off::before { background: var(--tp-bad); }
        .tp-whiteip-state.is-off { color: var(--tp-fg2); font-weight: 500; }
        .tp-whiteip-list { display: flex; flex-direction: column; margin-bottom: 12px; }
        .tp-whiteip-row {
            display: flex; align-items: baseline; justify-content: space-between; gap: 10px;
            padding: 6px 0; border-bottom: 1px solid var(--tp-border); font-size: 12.5px;
        }
        .tp-whiteip-row:last-child { border-bottom: 0; }
        .tp-whiteip-ip { font-weight: 650; font-variant-numeric: tabular-nums; }
        .tp-whiteip-meta { font-size: 11.5px; color: var(--tp-fg3); }
        .tp-whiteip-form { display: flex; flex-direction: column; gap: 10px; }
        .tp-whiteip-form select {
            font: inherit; color: var(--tp-fg);
            background: rgba(127,127,127,.10);
            border: 1px solid transparent; border-radius: 10px;
            padding: 8px 11px; width: 100%; outline: none; cursor: pointer;
        }
        .tp-whiteip-form select:focus { border-color: var(--tp-blue); }
        .tp-whiteip-apply { width: 100%; text-align: center; }
        .tp-whiteip-msg { width: 100%; }
        /* устройство для IPoE фиксировано — показываем текстом, не селектом */
        .tp-whiteip-dev-fixed { display: flex; flex-direction: column; gap: 4px; }
        .tp-whiteip-dev-fixed[hidden] { display: none; }
        .tp-whiteip-creds { display: flex; flex-direction: column; gap: 8px; }
        .tp-whiteip-creds[hidden] { display: none; }
        /* Логин и пароль в строку: логин — текстом (номер договора не меняется),
           пароль — полем. Одинаковый вид у обоих намекал бы, что логин тоже
           редактируется, а он уходит в RADIUS как User-Name. */
        .tp-whiteip-creds-row {
            display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 8px;
        }
        .tp-whiteip-cred-value {
            /* Те же метрики, что у соседнего input: строка должна стоять
               на одной линии с паролем, но без рамки и фона — иначе логин
               выглядит как редактируемое поле. */
            font-size: 14px; font-weight: 600; line-height: 20px;
            padding: 7px 0; min-height: 34px;
            color: var(--tp-fg); font-variant-numeric: tabular-nums;
            overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
            user-select: text;
        }
        .tp-whiteip-cred-value.is-bad { color: var(--tp-red); font-weight: 500; }
        .tp-whiteip-creds .tp-whiteip-password {
            font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        }
        .tp-whiteip-cred-hint { font-size: 11px; line-height: 1.4; color: var(--tp-fg3); }
        .tp-whiteip-cred-hint.is-bad { color: var(--tp-red); }
        .tp-whiteip-mac-wrap input {
            font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        }
        .tp-whiteip-dev-label {
            font-size: 11px; font-weight: 600; letter-spacing: .04em;
            text-transform: uppercase; color: var(--tp-fg3);
        }
        .tp-whiteip-dev-name { font-size: 12.5px; font-weight: 550; color: var(--tp-fg2); }
        .tp-whiteip-dev-name.is-bad { color: var(--tp-red); }

        /* ---- процессы */
        .tp-proc-state {
            font-size: 11px; font-weight: 600; color: var(--tp-fg3);
            background: rgba(127,127,127,.14); border-radius: 999px; padding: 1px 8px;
        }
        .tp-proc-state:empty { display: none; }
        /* Вкладки внутри карточки — те же, что у «Сессии»: оператор уже знает,
           как они выглядят и что счётчик справа от подписи. */
        .tp-proc-tabs { margin-bottom: 10px; }
        .tp-proc-list { display: flex; flex-direction: column; gap: 8px; }
        .tp-proc-row {
            display: flex; align-items: flex-start; justify-content: space-between;
            gap: 10px; padding: 6px 8px; margin: 0 -8px;
            border-bottom: 1px solid var(--tp-border);
        }
        .tp-proc-row:last-child { border-bottom: 0; }
        /* Кликабельная строка ведёт в карточку процесса. Подсветка при наведении
           нужна как подсказка: без неё список выглядит справочным, и оператор
           не догадывается, что по нему можно перейти. Отрицательный margin
           компенсирует боковые отступы — подсветка шире текста, но строка
           визуально не сдвигается. */
        .tp-proc-row.is-link { cursor: pointer; border-radius: 8px; }
        .tp-proc-row.is-link:hover { background: rgba(127,127,127,.09); }
        .tp-proc-row.is-link:hover .tp-proc-num { color: var(--tp-fg); }
        /* Фокус с клавиатуры: строка получает tabindex, и без видимой рамки
           было бы непонятно, где находится клавиатурный курсор. */
        .tp-proc-row.is-link:focus-visible {
            outline: 2px solid var(--tp-blue); outline-offset: 1px;
        }
        .tp-proc-main { min-width: 0; flex: 1 1 auto; }
        .tp-proc-name {
            font-size: 13px; font-weight: 550; color: var(--tp-fg);
            overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        /* Номер процесса — моноширинным и приглушённым: он нужен для ссылки
           в разговоре («посмотрите #16503»), но не должен перетягивать глаз. */
        .tp-proc-num {
            font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
            font-size: 12px; font-weight: 600; color: var(--tp-fg3);
        }
        .tp-proc-meta {
            font-size: 11.5px; color: var(--tp-fg3); margin-top: 2px;
            overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }

        /* ---- общие стили контролов
           В ERP поля и селекты приходят с нативным видом. Раньше стилизован
           был только .tp-whiteip-form select, а textarea письма и селекты
           «Отправитель»/«Что отправить» оставались системными — посреди
           оформленной карточки они читались как чужая вставка. */
        .tp-wrap input[type="text"],
        .tp-wrap input[type="password"],
        .tp-wrap input[type="number"],
        .tp-wrap select,
        .tp-wrap textarea {
            font: inherit; font-size: 13px; color: var(--tp-fg);
            background: var(--tp-fill-1);
            border: 1px solid var(--tp-border);
            border-radius: var(--tp-radius-sm);
            padding: 6px 9px; width: 100%; box-sizing: border-box;
        }
        .tp-wrap textarea { min-height: 74px; resize: vertical; line-height: 1.45; }
        .tp-wrap input[type="text"]:focus,
        .tp-wrap input[type="password"]:focus,
        .tp-wrap input[type="number"]:focus,
        .tp-wrap select:focus,
        .tp-wrap textarea:focus {
            outline: none; border-color: var(--tp-blue);
            box-shadow: 0 0 0 3px rgba(0,122,255,.14);
        }
        .tp-wrap input:disabled, .tp-wrap select:disabled, .tp-wrap textarea:disabled {
            opacity: .6; cursor: default;
        }

        /* ---- отправка доступа на почту */
        .tp-mail-form { display: flex; flex-direction: column; gap: 10px; }
        .tp-mail-to {
            font-family: var(--tp-font-mono);
            font-size: 13px;
        }
        .tp-mail-to[data-empty] { border-color: var(--tp-bad); }
        /* Предпросмотр письма: оператор видит, что уйдёт абоненту, до отправки.
           Моноширинный шрифт и переносы — потому что это готовый текст письма,
           и перенос строки в нём значим. */
        .tp-mail-preview {
            border: 1px solid var(--tp-border); border-radius: var(--tp-radius-md);
            padding: 8px 10px; background: var(--tp-fill-1);
        }
        .tp-mail-preview-title {
            font-size: 10px; font-weight: 700; letter-spacing: .06em;
            text-transform: uppercase; color: var(--tp-fg3); margin-bottom: 4px;
        }
        .tp-mail-preview-subject {
            font-size: 12.5px; font-weight: 600; margin-bottom: 6px;
        }
        .tp-mail-preview-text {
            margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
            font-size: 11.5px; line-height: 1.5; color: var(--tp-fg2);
            white-space: pre-wrap; word-break: break-word;
            max-height: 170px; overflow-y: auto;
        }
        .tp-mail-hint { font-size: 11px; line-height: 1.4; color: var(--tp-fg3); }
        .tp-mail-hint.is-bad { color: var(--tp-red); }
        .tp-mail .tp-msg:empty { display: none; }
        /* Произвольный текст: моноширинный не нужен — это обычное письмо,
           но переносы строк значимы, поэтому textarea, а не input. */
        .tp-mail-custom-wrap textarea {
            font: inherit; font-size: 13px; line-height: 1.45;
            resize: vertical; min-height: 96px;
        }
        .tp-mail-custom-wrap[hidden] { display: none; }
        .tp-mail-preview[hidden] { display: none; }

        /* ---- примечания */
        .tp-memo-actions { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
        .tp-memo-actions .tp-btn { padding: 7px 14px; }
        .tp-memo-count {
            font-size: 11px; font-weight: 600; color: var(--tp-fg3);
            background: rgba(127,127,127,.14); border-radius: 999px; padding: 1px 8px;
        }
        .tp-memo-count:empty { display: none; }
        .tp-memo-list { display: flex; flex-direction: column; gap: 10px; }
        .tp-memo-item {
            border-left: 3px solid rgba(127,127,127,.28);
            background: rgba(127,127,127,.06);
            border-radius: 8px; padding: 8px 10px;
        }
        .tp-memo-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
        .tp-memo-title-text { font-weight: 650; color: var(--tp-fg); min-width: 0; word-break: break-word; }
        .tp-memo-meta { font-size: 11px; color: var(--tp-fg3); margin-left: auto; white-space: nowrap; }
        /* Переносы строк в примечании значимые — поэтому pre, а не div */
        .tp-memo-text-body {
            margin: 5px 0 0; font: inherit; font-size: 12.5px; line-height: 1.5;
            color: var(--tp-fg2); white-space: pre-wrap; word-break: break-word;
        }
        .tp-memo-item-btns { display: flex; gap: 6px; margin-top: 7px; }
        .tp-memo-item-btns .tp-btn { padding: 4px 10px; font-size: 11.5px; font-weight: 600; }
        .tp-memo-form { display: flex; flex-direction: column; gap: 8px; margin-bottom: 10px; }
        /* hidden перебивается display:flex — возвращаем ему силу */
        .tp-memo-form[hidden] { display: none; }
        .tp-memo-form textarea {
            font: inherit; color: var(--tp-fg); resize: vertical; min-height: 70px;
            background: rgba(127,127,127,.10);
            border: 1px solid transparent; border-radius: 10px;
            padding: 8px 11px; width: 100%; outline: none;
            transition: border-color .15s, background .15s;
        }
        .tp-memo-form textarea:focus { border-color: var(--tp-blue); background: rgba(127,127,127,.06); }
        .tp-memo-form-btns { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
        .tp-memo-form-btns .tp-btn { padding: 7px 14px; }
        /* «Вернуть» — ссылка внутри сообщения об удалении, не отдельная кнопка */
        .tp-memo-undo {
            font: inherit; font-size: 12.5px; font-weight: 600; cursor: pointer;
            background: none; border: 0; padding: 0 2px; margin-left: 2px;
            color: var(--tp-blue); text-decoration: underline;
        }
        .tp-memo-undo[disabled] { opacity: .55; cursor: default; text-decoration: none; }

        /* ---- доверительный платёж: вложенность без второй карточки */
        .tp-trust-inner { display: block; }
        /* «Дней» + кнопка в одну строку: поле узкое, кнопка забирает остаток */
        .tp-trust-row { display: flex; align-items: flex-end; gap: 8px; }
        .tp-trust-days { flex: 0 0 72px; }
        .tp-trust-row .tp-apply { flex: 1 1 auto; }
        /* Подпись расчёта вместо трёх полей: долг + дни = сумма */
        .tp-trust-calc {
            margin-top: 8px; font-size: 11.5px; line-height: 1.4;
            color: var(--tp-fg3); font-variant-numeric: tabular-nums;
        }
        .tp-trust-calc b { color: var(--tp-fg); font-weight: 650; }
        .tp-trust-lead { font-size: 13px; color: var(--tp-fg2); margin: 0 0 14px; }
        .tp-trust-lead b { color: var(--tp-fg); font-weight: 650; }
        .tp-field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
        /* display: flex перебивает атрибут hidden — возвращаем ему силу.
           Без этого скрытое «Устройство» оставалось видимым при PPPoE. */
        .tp-field[hidden] { display: none; }
        .tp-field span { font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--tp-fg3); }
        .tp-field input, .tp-wrap input {
            font: inherit; color: var(--tp-fg);
            background: rgba(127,127,127,.10);
            border: 1px solid transparent; border-radius: 10px;
            padding: 8px 11px; width: 100%; outline: none; transition: border-color .15s, background .15s;
        }
        .tp-field input:focus { border-color: var(--tp-blue); background: rgba(127,127,127,.06); }
        .tp-field input { font-variant-numeric: tabular-nums; }
        .tp-btn {
            font: inherit; font-weight: 600; border: 0; cursor: pointer;
            padding: 9px 18px; border-radius: 12px; color: #fff;
            background: linear-gradient(180deg, #2b8dff, #007aff);
            box-shadow: 0 1px 1px rgba(0,0,0,.08), 0 6px 16px -8px rgba(0,122,255,.9);
            transition: transform .08s, filter .15s;
        }
        .tp-btn:hover { filter: brightness(1.05); }
        .tp-btn:active { transform: scale(.985); }
        .tp-btn[disabled] { opacity: .55; cursor: default; }
        .tp-btn.is-ghost {
            background: rgba(127,127,127,.12); color: var(--tp-fg); box-shadow: none;
        }
        .tp-msg { font-size: 12.5px; font-weight: 500; }
        .tp-msg.is-ok { color: var(--tp-ok); } .tp-msg.is-bad { color: var(--tp-bad); }

        .tp-hint { font-size: 12px; color: var(--tp-fg3); margin-top: 10px; }
        /* Единое пустое состояние. Раньше «Сервисов нет» и «Активных сессий
           нет» стояли с разными отступами и кеглем в одной колонке. */
        .tp-empty { padding: 12px 0; color: var(--tp-fg3); font-size: 12.5px; }
        .tp-loading { color: var(--tp-fg3); padding: 24px; font-size: 13px; }
        .tp-err { color: var(--tp-red); padding: 10px 0; }
        .tp-wrap a { color: var(--tp-blue); text-decoration: none; }
        .tp-wrap a:hover { text-decoration: underline; }

        /* ---- сессии */
        .tp-sess-head {
            display: flex; align-items: center; justify-content: space-between;
            gap: 10px; margin-bottom: 10px; flex-wrap: wrap;
        }
        .tp-tabs-mini { display: inline-flex; background: rgba(127,127,127,.12); border-radius: 10px; padding: 2px; }
        .tp-tabs-mini button {
            font: inherit; font-size: 12px; font-weight: 600; border: 0; cursor: pointer;
            padding: 5px 12px; border-radius: 8px; background: transparent; color: var(--tp-fg2);
        }
        .tp-tabs-mini button:hover { background: var(--tp-fill-1); color: var(--tp-fg); }
        .tp-tabs-mini button:focus-visible { outline: 2px solid var(--tp-blue); outline-offset: 1px; }
        .tp-tabs-mini button.is-on { background: var(--tp-card); color: var(--tp-fg); box-shadow: 0 1px 2px rgba(0,0,0,.08); }
        .tp-live .tp-dot-live {
            position: relative;
            width: 7px; height: 7px; border-radius: 50%; background: var(--tp-green);
        }
        /* Пульс — тем же способом, что у .tp-signal: transform + opacity на
           псевдоэлементе. Индикатор автообновления виден всегда, пока открыт
           договор, поэтому box-shadow здесь стоил бы постоянной перерисовки. */
        .tp-live .tp-dot-live::after {
            content: ''; position: absolute; inset: 0; border-radius: 50%;
            background: var(--tp-green); opacity: 0;
            animation: tpRing 1.8s ease-out infinite;
        }
        /* индикатор автообновления в заголовке карточки */
        .tp-live {
            display: inline-flex; align-items: center; gap: 5px; margin-left: auto;
            font-size: 10.5px; font-weight: 600; letter-spacing: .01em;
            color: var(--tp-fg3); text-transform: none; white-space: nowrap;
        }
        .tp-sess-empty { padding: 14px 0; color: var(--tp-fg3); font-size: 13px; }
        .tp-sess-row {
            display: grid; grid-template-columns: 1fr auto; gap: 8px;
            padding: 9px 0; border-bottom: 1px solid var(--tp-border); align-items: center;
        }
        .tp-sess-row:last-child { border-bottom: 0; }
        .tp-sess-main { min-width: 0; }
        .tp-sess-svc { font-weight: 600; font-size: 13px; }
        .tp-sess-meta { font-size: 11.5px; color: var(--tp-fg2); margin-top: 2px; font-variant-numeric: tabular-nums; }
        .tp-sess-btn {
            font: inherit; font-size: 12px; font-weight: 600; cursor: pointer;
            padding: 5px 11px; border-radius: var(--tp-radius-sm); border: 0; white-space: nowrap;
            background: var(--tp-bad-bg); color: var(--tp-bad);
        }
        .tp-sess-btn:hover { filter: brightness(.96); }
        .tp-sess-btn[disabled] { opacity: .5; cursor: default; }
        .tp-sess-status { font-size: 11.5px; margin-top: 4px; line-height: 1.3; }
        .tp-sess-status.is-ok { color: var(--tp-ok); }
        .tp-sess-status.is-bad { color: var(--tp-bad); }
        .tp-fresh { animation: tpFresh 1.6s ease-out; }
        @keyframes tpFresh {
            from { background: rgba(52,199,89,.22); }
            to   { background: transparent; }
        }

        /* ---- компактная карточка сессий в колонке */
        .tp-sessions .tp-sess-row { padding: 7px 0; }
        .tp-sessions .tp-sess-meta { line-height: 1.35; }

        /* счётчик активных сессий в шапке карточки */
        .tp-count {
            display: inline-block; min-width: 17px; text-align: center;
            font-size: 11px; font-weight: 700; line-height: 17px;
            border-radius: 9px; padding: 0 5px; margin-left: 4px;
            background: rgba(127,127,127,.2); color: var(--tp-fg3);
            font-variant-numeric: tabular-nums;
        }
        .tp-count.is-on { background: var(--tp-ok-bg); color: var(--tp-ok); }

        /* ---- пароли */
        .tp-pwd-row {
            display: flex; align-items: center; justify-content: space-between;
            gap: 10px; padding: 7px 0; border-bottom: 1px solid var(--tp-border);
            min-width: 0;
        }
        .tp-pwd-row:last-child { border-bottom: 0; }
        .tp-pwd-name { font-size: 12.5px; color: var(--tp-fg2); min-width: 0; flex: 1 1 auto;
            white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .tp-pwd-val {
            font-family: var(--tp-font-mono);
            font-size: 13px; font-weight: 600; letter-spacing: .02em;
            cursor: pointer; white-space: nowrap; user-select: all;
            /* Длинный пароль (32+ символа) в узкой третьей колонке раньше
               выталкивал подпись в ноль и вылезал за карточку: nowrap без
               ограничения ширины. Полное значение остаётся в title. */
            max-width: 52%; overflow: hidden; text-overflow: ellipsis;
            padding: 2px 7px; border-radius: var(--tp-radius-sm);
            background: var(--tp-fill-2);
        }
        .tp-pwd-val:hover { background: var(--tp-fill-3); }
        .tp-pwd-val:focus-visible { outline: 2px solid var(--tp-blue); outline-offset: 1px; }
        .tp-pwd-val.is-empty { background: transparent; cursor: default; color: var(--tp-fg3); font-size: 12px; }
        /* Бейдж «1 из 27» рядом со статусом: показывает, сколько записей
           с этим паролем в биллинге и сколько из них действует. */
        .tp-pwd-count {
            font-size: 10px; font-weight: 600; color: var(--tp-fg3);
            padding: 1px 6px; border-radius: var(--tp-radius-pill);
            background: var(--tp-fill-2); white-space: nowrap; margin-left: 2px;
        }
        .tp-pwd-state.is-good { color: var(--tp-ok); background: var(--tp-ok-bg); }
        /* Уменьшенный чип: раньше это делалось инлайн-стилем
           style="padding:1px 7px" в шести местах — такой стиль нельзя
           переопределить темой. */
        .tp-chip.is-xs { padding: 1px 7px; }
        /* ---- раскрытие истории сервисов
           Действующие сервисы видны сразу, закрытые и удалённые — под
           <details>. Раньше их не было видно вовсе, и оператор не мог
           посмотреть, когда и с каким адресом сервис закрыли. */
        .tp-svc-more { margin-top: 2px; }
        .tp-svc-more > summary {
            display: flex; align-items: baseline; justify-content: space-between; gap: 10px;
            padding: 7px 0; cursor: pointer; list-style: none;
            font-size: 12.5px; color: var(--tp-fg3);
            border-top: 1px solid var(--tp-border);
        }
        .tp-svc-more > summary::-webkit-details-marker { display: none; }
        .tp-svc-more > summary:hover { color: var(--tp-fg2); }
        .tp-svc-more > summary:focus-visible { outline: 2px solid var(--tp-blue); outline-offset: 2px; }
        .tp-svc-more-label { font-style: italic; }
        .tp-svc-more-hint { font-size: 11px; white-space: nowrap; }
        /* Подпись «показать / скрыть» переключается по состоянию details. */
        .tp-svc-more-hint::after { content: 'показать'; }
        .tp-svc-more[open] .tp-svc-more-hint::after { content: 'скрыть'; }
        .tp-svc-more-body { padding-top: 2px; }

        /* ---- скелетон загрузки */
        .tp-skeleton { display: flex; flex-direction: column; gap: 8px; padding: 4px 0; }
        .tp-skeleton-line {
            height: 11px; border-radius: 5px;
            background: linear-gradient(90deg, rgba(127,127,127,.12), rgba(127,127,127,.22), rgba(127,127,127,.12));
            background-size: 200% 100%;
            animation: tpShimmer 1.4s ease-in-out infinite;
        }
        .tp-skeleton-line:nth-child(1) { width: 65%; }
        .tp-skeleton-line:nth-child(2) { width: 88%; }
        .tp-skeleton-line:nth-child(3) { width: 74%; }
        .tp-skeleton-line:nth-child(4) { width: 55%; }
        @keyframes tpShimmer {
            0%   { background-position: 200% 0; }
            100% { background-position: -200% 0; }
        }
        .tp-lazy.is-filled > .tp-lazy-body > .tp-skeleton { display: none; }

        /* Анимация висит на ::after, а не на самом элементе: без ::after
           правило не срабатывало и пульсации игнорировали настройку ОС. */
        @media (prefers-reduced-motion: reduce) {
            .tp-skeleton-line,
            .tp-signal::after, .tp-signal,
            .tp-dot-live::after, .tp-dot-live,
            .tp-verdict-skel, .tp-fresh { animation: none !important; }
        }

        /* ---- история статусов */
        .tp-timeline { display: flex; flex-direction: column; }
        .tp-tl-row {
            display: flex; gap: 9px; padding: 6px 0; position: relative;
        }
        .tp-tl-dot {
            flex: 0 0 auto; width: 7px; height: 7px; border-radius: 50%;
            margin-top: 5px; background: var(--tp-fg3);
        }
        .tp-tl-row.is-ok .tp-tl-dot { background: var(--tp-green); }
        .tp-tl-row.is-warn .tp-tl-dot { background: var(--tp-orange); }
        .tp-tl-body { min-width: 0; flex: 1; }
        .tp-tl-head {
            display: flex; align-items: baseline; justify-content: space-between; gap: 8px;
        }
        .tp-tl-status { font-size: 12.5px; font-weight: 600; }
        .tp-tl-row.is-ok .tp-tl-status { color: var(--tp-ok); }
        .tp-tl-row.is-warn .tp-tl-status { color: var(--tp-warn); }
        .tp-tl-period { font-size: 10.5px; color: var(--tp-fg3); white-space: nowrap; font-variant-numeric: tabular-nums; }
        .tp-tl-comment { font-size: 11.5px; color: var(--tp-fg2); margin-top: 1px; line-height: 1.3; }

        /* ---- платежи */
        .tp-pay-date { white-space: nowrap; font-variant-numeric: tabular-nums; font-size: 12.5px; }
        .tp-pay-type { font-size: 11.5px; color: var(--tp-fg2); }
    `;

    function row(k, v) {
        if (v == null || v === '') return '';
        return `<dt>${esc(k)}</dt><dd>${v}</dd>`;
    }

    /* ------------------------------------------------------- GetOLT: ONU/OLT */

    /**
     * Оценка уровня сигнала, дБм.
     *
     * Пороги RX — по отраслевым нормам GPON (G.984.2 Class B+), а не по
     * консервативным бейджам GetOLT. Плагин считает «засветом» всё выше
     * −15 дБм, но у ONU перегрузка приёмника начинается около −8 дБм:
     * при −13 дБм связь работает с большим запасом, и красный цвет на таком
     * значении только пугал операторов. Соседние ONU на том же порту
     * показывают −11…−14 дБм, то есть это нормальный режим ветки.
     *
     *   ярче −8      — пересвет, риск насыщения приёмника (нужен аттенюатор);
     *   −8…−25       — норма: от сильного сигнала до идеального окна;
     *   −25…−28      — на пределе, запаса нет (чистить коннекторы);
     *   слабее −28   — вне допуска (искать потери).
     *
     * TX оценивается отдельно: это мощность передатчика самого ONU, у неё
     * паспортное окно 0.5…5 дБм. Общие пороги RX к ней неприменимы —
     * любое положительное TX выглядело бы «засветом».
     */
    function signalVerdict(dbm, kind) {
        const v = toNum(dbm);
        if (!Number.isFinite(v)) return '';

        // TX (передатчик ONU): норма 0.5…5 дБм по G.984.2 Class B+.
        // Ниже 0 — модуль деградирует; выше +7 — выход за паспорт, обычно
        // следствие ошибки калибровки или неисправного модуля.
        if (kind === 'tx') {
            if (v > 7) return 'bad';
            if (v < 0) return 'warn';
            return 'good';
        }

        if (v > -8) return 'bad';         // пересвет
        if (v > -25) return 'good';       // −8…−25: норма
        if (v > -28) return 'warn';       // −25…−28: на пределе
        return 'bad';                     // слабее −28
    }

    /**
     * Текст страницы с переносами строк.
     *
     * body.innerText у документа, разобранного через DOMParser, не расставляет
     * переносы: документ не отрендерен, и <br>/<div> склеиваются в одну строку.
     * Поэтому переносы расставляем сами до разбора.
     */
    function htmlToText(html) {
        const withBreaks = String(html || '')
            .replace(/<script[\s\S]*?<\/script>/gi, ' ')
            .replace(/<style[\s\S]*?<\/style>/gi, ' ')
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/(p|div|tr|li|dd|dt|td|th|h[1-6]|table|section)>/gi, '\n')
            .replace(/<[^>]+>/g, ' ');
        const tmp = document.createElement('div');
        tmp.innerHTML = withBreaks;
        return String(tmp.textContent || '')
            .replace(/[ \t\u00a0]+/g, ' ')
            .replace(/\n\s*\n+/g, '\n')
            .trim();
    }

    /**
     * Достаёт из HTML GetOLT пары «подпись — значение».
     *
     * Плагин рисует карточку терминала разными способами в зависимости от
     * версии: то как список определений, то таблицей, то строкой
     * «Модель: HG8245H». Поэтому собираем словарь из всех вариантов сразу,
     * а не привязываемся к одной вёрстке.
     */
    function getoltPairs(body, html) {
        const map = {};
        const put = (k, v) => {
            const key = normLabel(k);
            const val = String(v || '').replace(/\s+/g, ' ').trim();
            if (!key || !val || map[key]) return;
            if (val.length > 200) return;
            map[key] = val;
        };

        // 1) <dt>подпись</dt><dd>значение</dd>
        body.querySelectorAll('dt').forEach((dt) => {
            const dd = dt.nextElementSibling;
            if (dd && dd.tagName === 'DD') put(dt.textContent, dd.textContent);
        });

        // 2) <th>подпись</th><td>значение</td> и «td: td» в одной строке
        body.querySelectorAll('tr').forEach((tr) => {
            const ths = tr.querySelectorAll('th');
            const tds = tr.querySelectorAll('td');
            if (ths.length === 1 && tds.length === 1) {
                put(ths[0].textContent, tds[0].textContent);
                return;
            }
            if (tds.length === 2) {
                const k = tds[0].textContent;
                if (k && k.length < 40 && /[А-Яа-яA-Za-z]/.test(k)) put(k, tds[1].textContent);
            }
        });

        // 3) label/value в разметке вида .label + .value, .name + .val
        body.querySelectorAll('.label, .name, .param-name, .title')
            .forEach((el) => {
                const sib = el.nextElementSibling;
                if (!sib) return;
                if (!/value|val|param-value/i.test(sib.className || '')) return;
                put(el.textContent, sib.textContent);
            });

        // 4) Строки текста «Подпись: значение» — последний резерв.
        //    Текст берём из исходного HTML: у DOMParser-документа innerText
        //    не расставляет переносы, и все пары слипаются в одну строку.
        const text = htmlToText(html || String(body.innerHTML || ''));
        text.split(/\n+/).forEach((line) => {
            const m = line.match(/^\s*([^:]{2,40}?)\s*:\s*(.{1,120})$/);
            if (m) put(m[1], m[2]);
        });

        return map;
    }

    /** Ищет в словаре значение по любому из ключей-шаблонов. */
    function pairFind(map, re) {
        const keys = Object.keys(map);
        for (let i = 0; i < keys.length; i++) {
            if (re.test(keys[i])) return map[keys[i]];
        }
        return '';
    }

    /** Число из строки вида «-18.76 dBm» / «4747 м» / «3.34 V». */
    function pickNum(v) {
        const m = String(v == null ? '' : v).replace(/\u2212/g, '-').match(/-?\d+(?:[.,]\d+)?/);
        return m ? Number(m[0].replace(',', '.')) : NaN;
    }

    /**
     * Разбирает страницу GetOLT в список ONU.
     *
     * Реальная разметка плагина (проверено на живой карточке):
     *   .getolt-onu-card
     *     .getolt-mac              — MAC ONU, напр. HWTC:50:DA:E8:53
     *     .getolt-onu-status       — класс getolt-online / getolt-offline, текст ONLINE
     *     .getolt-update-time      — «Обновлено: 53 мин. назад», точное время в title
     *     .getolt-onu-row > .getolt-onu-col
     *         .getolt-onu-label + .getolt-onu-value   — пары «подпись — значение»
     *     .getolt-macs-list .getolt-mac-item          — MAC за ONU (устройства абонента)
     *     table.getolt-neighbors-table                — соседи по порту
     *
     * Пары «подпись — значение» — основной источник: подписи в плагине
     * стабильные (OLT IP, Порт / ONU ID, Сигнал RX, Сигнал TX, Дистанция,
     * Температура, Напряжение, Статус). Разбор по классам, а не по тексту,
     * чтобы не зависеть от порядка строк.
     */
    function parseGetoltOnu(html) {
        const body = parseHtml(html);
        const cards = Array.from(body.querySelectorAll('.getolt-onu-card'));

        const readCard = (card) => {
            // Пары подпись/значение внутри карточки
            const map = {};
            card.querySelectorAll('.getolt-onu-label').forEach((label) => {
                const valEl = label.parentElement
                    && label.parentElement.querySelector('.getolt-onu-value');
                const key = normLabel(label.textContent);
                const val = valEl ? String(valEl.textContent || '').replace(/\s+/g, ' ').trim() : '';
                if (key && val && !map[key]) map[key] = val;
            });

            const mac = (card.querySelector('.getolt-mac') || {}).textContent || '';
            const statusEl = card.querySelector('.getolt-onu-status');
            const statusText = statusEl ? String(statusEl.textContent || '').trim() : '';
            const statusCls = statusEl ? String(statusEl.className || '') : '';

            const upd = card.querySelector('.getolt-update-time');
            const updatedTitle = upd ? (upd.getAttribute('title') || '') : '';

            // MAC устройств за ONU — то, что реально видит абонентский роутер
            const macs = Array.from(card.querySelectorAll('.getolt-macs-list .getolt-mac-item'))
                .map((el) => String(el.textContent || '').trim())
                .filter(Boolean);

            // «Порт / ONU ID» приходит одной строкой «11 / 91»
            const portRaw = map[normLabel('Порт / ONU ID')] || map[normLabel('Порт')] || '';
            const portParts = portRaw.split('/').map((s) => s.trim()).filter(Boolean);

            return {
                mac: String(mac).trim(),
                status: statusText,
                online: /getolt-online/i.test(statusCls) || /^(online|up)$/i.test(statusText),
                updated: updatedTitle || (upd ? String(upd.textContent || '').trim() : ''),
                oltIp: map[normLabel('OLT IP')] || '',
                port: portParts[0] || '',
                onuId: portParts[1] || '',
                rx: pickNum(map[normLabel('Сигнал RX')]),
                tx: pickNum(map[normLabel('Сигнал TX')]),
                distance: map[normLabel('Дистанция')] || '',
                temperature: map[normLabel('Температура')] || '',
                voltage: map[normLabel('Напряжение')] || '',
                state: map[normLabel('Статус')] || statusText,
                macs,
                raw: map,
            };
        };

        if (cards.length) return cards.map(readCard);

        // Плагин не отдал карточек ONU — возможно, у договора нет ONU либо
        // изменилась вёрстка. Пробуем старый «плоский» разбор, чтобы не терять
        // данные, если GetOLT вернут к прежнему виду.
        const map = getoltPairs(body, html);
        if (!Object.keys(map).length) return [];
        const rawText = htmlToText(html);
        const legacy = {
            mac: pairFind(map, /mac/i)
                || (rawText.match(/\b([0-9a-f]{2}(?:[:\-.][0-9a-f]{2}){5})\b/i) || [])[1] || '',
            status: pairFind(map, /(статус|status|состояни|state)/i),
            online: /online|up|active|работа/i.test(pairFind(map, /(статус|status|состояни|state)/i)),
            updated: '',
            oltIp: pairFind(map, /^(olt|головн|станц)/i),
            port: pairFind(map, /(порт|port|pon)/i),
            onuId: '',
            rx: pickNum(pairFind(map, /(rx|прием|приём)/i)),
            tx: pickNum(pairFind(map, /(tx|передач)/i)),
            distance: pairFind(map, /(расстоян|distance)/i),
            temperature: pairFind(map, /(температур|temp)/i),
            voltage: pairFind(map, /(напряжен|volt)/i),
            state: pairFind(map, /(статус|status|состояни|state)/i),
            macs: [],
            raw: map,
        };
        const known = [legacy.mac, legacy.oltIp, legacy.port, legacy.status].filter(Boolean).length;
        if (!known && !Number.isFinite(legacy.rx)) return [];
        return [legacy];
    }

    /** Цветной бейдж уровня сигнала: good / warn / bad. */
    function signalChip(label, dbm, kind) {
        const v = toNum(dbm);
        if (!Number.isFinite(v)) return '';
        const verdict = signalVerdict(v, kind) || 'warn';
        const sign = v > 0 ? '+' : '';
        // Подсказка при наведении объясняет, по каким границам оценено:
        // у RX и TX они разные, и «красный» на +1.7 дБм иначе выглядит ошибкой.
        const hint = kind === 'tx'
            ? 'норма 0.5…5 дБм'
            : 'норма −8…−25 дБм';
        return `<span class="tp-chip tp-sig is-${verdict}" title="${esc(label)}: ${v.toFixed(1)} дБм (${hint})">`
            + `${esc(label)} ${sign}${v.toFixed(1)} дБм</span>`;
    }

    /**
     * Последние два октета IPv4: «10.90.94.241» → «94.241».
     *
     * Именно в таком виде адрес вбивают в поиск на OLT — полный адрес там
     * не нужен, а набирать «94.241» руками из строки «10.90.94.241» долго.
     * Возвращаем пустую строку, если это не IPv4 из четырёх чисел: тогда
     * копировать нечего и подчёркивать нечего.
     */
    function shortIp(ip) {
        const parts = String(ip || '').trim().split('.');
        if (parts.length !== 4) return '';
        if (!parts.every((p) => /^\d{1,3}$/.test(p))) return '';
        return parts[2] + '.' + parts[3];
    }

    /** Блок «Оборудование»: ONU с OLT + объекты договора из биллинга. */
    function renderEquipment(onuList, objects) {
        const onu = onuList || [];
        const objs = objects || [];
        let html = '';

        if (onu.length) {
            html += '<div class="tp-eq-group">GPON</div>';
            onu.forEach((o) => {
                // Где стоит: OLT + порт/ONU ID — то, что нужно диспетчеру для выезда.
                // Адрес OLT делаем копируемым: на OLT его ищут по последним двум
                // октетам, поэтому в буфер уходит «94.241», а не «10.90.94.241».
                // Порт и ONU ID копировать не даём — их набирают в других полях.
                const oltShort = shortIp(o.oltIp);
                const place = [
                    o.oltIp
                        ? (oltShort
                            ? `OLT <span class="tp-copy" data-tp-copy="${esc(oltShort)}"`
                                + ` title="Нажмите, чтобы скопировать ${esc(oltShort)}">${esc(o.oltIp)}</span>`
                            : `OLT ${esc(o.oltIp)}`)
                        : '',
                    o.port ? `порт ${o.port}${o.onuId ? ' / ONU ' + o.onuId : ''}` : '',
                ].filter(Boolean).join(' · ');

                const chips = [
                    signalChip('Rx', o.rx, 'rx'),
                    signalChip('Tx', o.tx, 'tx'),
                ].filter(Boolean).join('');

                // Телеметрия модуля: температура, напряжение, дистанция
                const telemetry = [o.distance, o.temperature, o.voltage]
                    .filter(Boolean).join(' · ');

                // MAC за ONU — устройство абонента; в плагине это список,
                // показываем первый и счётчик остальных
                const macs = o.macs || [];
                const macLine = macs.length
                    ? `${macs[0]}${macs.length > 1 ? ` и ещё ${macs.length - 1}` : ''}`
                    : '';

                html += `<div class="tp-device">
                    <div class="tp-device-icon">${o.online ? '●' : '○'}</div>
                    <div class="tp-device-main">
                        <div class="tp-device-name">ONU
                            ${o.online
                                ? '<span class="tp-chip is-good">online</span>'
                                : `<span class="tp-chip is-bad">${esc(o.state || 'offline')}</span>`}
                        </div>
                        ${o.mac ? `<div class="tp-device-meta tp-mono">MAC ${esc(o.mac)}</div>` : ''}
                        ${place ? `<div class="tp-device-meta">${place}</div>` : ''}
                        ${macLine ? `<div class="tp-device-meta tp-mono">за ONU: ${esc(macLine)}</div>` : ''}
                        ${telemetry ? `<div class="tp-device-meta">${esc(telemetry)}</div>` : ''}
                        ${chips ? `<div class="tp-chips tp-eq-chips">${chips}</div>` : ''}
                        ${o.updated ? `<div class="tp-device-meta tp-eq-upd">Обновлено: ${esc(o.updated)}</div>` : ''}
                    </div>
                </div>`;
            });
        }

        if (objs.length) {
            html += '<div class="tp-eq-group">Объекты договора</div>';
            objs.forEach((e) => {
                html += `<div class="tp-device">
                    <div class="tp-device-icon">▣</div>
                    <div class="tp-device-main">
                        <div class="tp-device-name">${esc(e.name)}</div>
                        <div class="tp-device-meta">${esc(e.type)}${e.period ? ' · ' + esc(e.period) : ''}</div>
                    </div>
                </div>`;
            });
        }

        return html;
    }

    /* ------------------------------------------------------------ main build */

    /** Мини-скелетон для блоков, которые догружаются фоном. */
    function skeleton(lines) {
        let out = '<div class="tp-skeleton">';
        for (let i = 0; i < (lines || 3); i++) out += '<div class="tp-skeleton-line"></div>';
        return out + '</div>';
    }

    /**
     * Сборка панели в две фазы:
     *  1) мгновенно — статус, абонент, тариф, баланс, состояние связи (только данные из DOM);
     *  2) фоном — всё остальное, блоки заполняются по мере прихода ответов.
     * Возвращает HTML каркаса; фоновая часть стартует сразу после вставки.
     */
    async function buildContent(panel) {
        // Стили вставляются один раз на страницу, а не в разметку каждой панели:
        // раньше ~35 КБ CSS заново парсились при каждой перерисовке договора.
        injectStyle();

        // ID берём из карточки, в которую вставляется вкладка, а не из URL
        const host = panel && panel.closest('#content > div[id^="contract_bill-"]');
        const id = (panel && panel.dataset.contractId) || ERP.contractId(host);
        if (!id) return '<div class="tp-err">Не удалось определить ID договора.</div>';

        const params = await ERP.params(id);
        // Результат запоминаем на панели: hydrate() берёт его отсюда, а не
        // читает #treeTable второй раз. Разбор таблицы — это обход всех строк
        // с пересчётом вёрстки, и делать его дважды на одну отрисовку незачем.
        if (panel) panel._tpParams = params;

        // Всё, что можно взять из уже отрисованной карточки — берём без сети
        const outNum = toNum(params.balanceOut);
        const limitNum = toNum(params.limit);

        // ---- карточка абонента: шапка с ФИО + группы полей.
        // Данные берутся из уже отрисованной карточки ERP (без сети),
        // тариф и баланс догружаются фоном.
        const fio = params.fields['ФИО'] || '';
        const contractNo = params.fields['Номер договора']
            || params.fields['Номер договора в Carbon']
            || (ERP.contractTitle(host).match(/^([A-Z]{2,}\d+)/) || [])[1] || '';

        // Статус — прямо в шапке, рядом с ФИО.
        //
        // Раньше он был только строкой в группе «Договор», ниже ФИО и контактов,
        // и на «Заморозке» это вводило в заблуждение: сверху всё выглядело
        // нормально, сессий нет, а почему — непонятно. Оператор узнавал причину,
        // только провалившись в стандартную вкладку ERP. Теперь статус виден
        // первым, ещё до чтения данных, и подсвечен цветом.
        //
        // Цвета по смыслу:
        //   • активен            — зелёный, всё работает;
        //   • заморозка/приостановлен — жёлтый, услуги на паузе по статусу;
        //   • закрыт/удалён/отключён  — красный, договор недействующий.
        // Незнакомый статус тоже жёлтый: лучше привлечь внимание, чем показать
        // нейтральный серый и пропустить проблему.
        const statusChip = (() => {
            const raw = String(params.status || '').trim();
            if (!raw) return '';
            const cls = /^актив/i.test(raw) ? 'is-good'
                : /закрыт|удал|отключ|блокиров/i.test(raw) ? 'is-bad'
                    : 'is-warn';
            return `<span class="tp-chip ${cls} tp-client-status">${esc(raw)}</span>`;
        })();

        // Служебные признаки договора из #treeTable: режим расчётов и тип лица.
        // Раньше они читались в params(), но нигде не выводились — оператор не видел
        // ни «Дебет/Кредит», ни «Физическое/Юридическое» без перехода на «Параметры».
        const metaRows = [
            ['Договор', contractNo],
            ['Лицо', params.person],
            ['Режим', params.mode],
            ['Объекты', params.objects],
            ['Статус', params.status],
        ].map(([k, v]) => row(k, v ? esc(v) : '')).join('');
        const contractMeta = metaRows
            ? `<div class="tp-client-group">
                    <div class="tp-client-group-title">Договор</div>
                    <dl class="tp-rows">${metaRows}</dl>
                </div>`
            : '';

        let clientRows = '';
        PARAM_GROUPS.forEach(([groupTitle, fields]) => {
            let rowsHtml = '';
            fields.forEach(([param, label]) => {
                let value = params.fields[param] || '';
                if (param === 'E-mail') {
                    value = value.replace(/^<|>$/g, '');
                    if (value) value = `<a href="mailto:${esc(value)}">${esc(value)}</a>`;
                }
                if (param === 'Номер договора') value = esc(contractNo);
                rowsHtml += row(label, value);            });
            // Пустую группу не рисуем — иначе остаётся заголовок без данных
            if (rowsHtml) {
                clientRows += `<div class="tp-client-group">
                    <div class="tp-client-group-title">${esc(groupTitle)}</div>
                    <dl class="tp-rows">${rowsHtml}</dl>
                </div>`;
            }
        });

        const clientTariffCard = `<div class="tp-card tp-client-tariff tp-lazy" data-lazy="tariff">
            <div class="tp-client-head">
                <div class="tp-client-fio">${esc(fio || 'Абонент')}</div>
                ${contractNo ? `<div class="tp-client-contract">${esc(contractNo)}</div>` : ''}
                ${statusChip}
            </div>
            ${clientRows}
            ${contractMeta}
            <div class="tp-sect">
                <div class="tp-sect-head"><span>Тариф и скорость</span></div>
                <div class="tp-lazy-body">${skeleton(3)}</div>
            </div>
            <div class="tp-lazy tp-balance-sect" data-lazy="balance">
                <div class="tp-sect-head"><span>Баланс${params.balanceMonth ? ' · ' + esc(params.balanceMonth) : ''}</span></div>
                <div class="tp-lazy-body">${skeleton(2)}</div>
            </div>
        </div>`;
        // ---- каркас: блоки с плейсхолдерами, данные придут фоном
        // «История статусов» и «Платежи» свёрнуты: это справочные данные,
        // которые нужны редко, а места занимают много.
        const statusCard = `<div class="tp-card tp-lazy tp-fold" data-lazy="status">
            <details>
                <summary class="tp-card-title"><span class="tp-dot"></span>История статусов<span class="tp-fold-caret"></span></summary>
                <div class="tp-lazy-body">${skeleton(4)}</div>
            </details>
        </div>`;

        const payCard = `<div class="tp-card tp-lazy tp-fold" data-lazy="payments">
            <details>
                <summary class="tp-card-title"><span class="tp-dot"></span>Платежи<span class="tp-fold-caret"></span></summary>
                <div class="tp-lazy-body">${skeleton(4)}</div>
            </details>
        </div>`;

        /*
         * «Лимит» — отдельный блок, потому что это не только текущее число.
         *
         * В карточке ERP «Лимит» — это вкладка с историей изменений и списком
         * заданий на автоматический возврат (updateLimit с period создаёт
         * задание). Скрипт уже запрашивал limitInfo() ради доверительного
         * платежа, но историю и задания нигде не показывал: оператор не видел,
         * кто и когда понизил лимит и вернётся ли он сам.
         */
        const limitCard = `<div class="tp-card tp-lazy tp-fold" data-lazy="limit">
            <details>
                <summary class="tp-card-title"><span class="tp-dot"></span>Лимит и задания<span class="tp-fold-caret"></span></summary>
                <div class="tp-lazy-body">${skeleton(4)}</div>
            </details>
        </div>`;

        const pwdCard = '';

        /*
         * «Действия» = деньги + доверительный платёж. Раньше это были две карточки,
         * и они повторяли друг друга: «Состояние связи» показывало остаток/лимит
         * и вердикт «вносить не нужно», а «Доверительный платёж» — то же решение
         * другими словами. Один блок денег, одна кнопка, никаких повторов.
         */
        const moneyPlaceholder = renderMoney({
            outNum,
            limitNum,
            fee: null,
            pending: true,
            statusText: params.status || '',
        });

        const actionsCard = `<div class="tp-card tp-actions-card">
            <div class="tp-card-title">
                <span class="tp-dot"></span>Доверительный платёж
                <span class="tp-live" title="Обновляется автоматически"><span class="tp-dot-live"></span>Автообновление</span>
            </div>
            <div data-role="money-slot">${moneyPlaceholder}</div>
            <div class="tp-lazy" data-lazy="trust">
                <div class="tp-lazy-body">${skeleton(2)}</div>
            </div>
        </div>`;

        /*
         * «Белый IP» — выдача публичного адреса.
         *
         * По документации BGBilling публичный адрес — это статический IP из
         * категории ресурсов (ip.resource.categoryId), выдаваемый сервису IPoE
         * (bgbilling.ru/versions/v7.2/doc/43385952.html, 43385982.html).
         * Категории в биллинге называются «IPoE белые» / «IPoE серые», поэтому
         * список свободных адресов берём из плагина inetip (freeIpList).
         */
        const whiteIpCard = `<div class="tp-card tp-whiteip tp-lazy" data-lazy="whiteIp">
            <div class="tp-card-title">
                <span class="tp-dot"></span>Белый IP
                <span class="tp-whiteip-current" data-role="whiteip-current"></span>
            </div>
            <div class="tp-lazy-body">${skeleton(2)}</div>
        </div>`;

        /*
         * «Примечания» — тот же узел, что в дереве карточки BGBilling.
         *
         * Оператор держит там пометки по абоненту (договорённости, особенности
         * монтажа, «звонить только вечером»). Раньше за ними нужно было уходить
         * в «Параметры», теряя контекст разговора; теперь они рядом с действиями
         * и правятся на месте. Счётчик в шапке показывает, есть ли записи,
         * не раскрывая содержимого.
         */
        const memoCard = `<div class="tp-card tp-memo tp-lazy" data-lazy="memo">
            <div class="tp-card-title">
                <span class="tp-dot"></span>Примечания
                <span class="tp-memo-count" data-role="memo-count"></span>
            </div>
            <div class="tp-lazy-body">${skeleton(1)}</div>
        </div>`;

        /*
         * «Сессия и подключение» — один блок вместо двух.
         *
         * Почему это логично: в BGBilling сессия и ошибка авторизации — две стороны
         * одного RADIUS-обмена. Access-Accept даёт сессию, Access-Reject даёт ошибку.
         * Сам биллинг показывает их в одном мониторе (Текущие / Логи / Ошибки),
         * а не двумя разными экранами. Держать их врозь значило заставлять оператора
         * сопоставлять «есть ли сессия» и «почему её нет» в двух местах.
         *
         * Три вкладки внутри одной карточки: Активные / История / Ошибки.
         */
        const sessionsCard = `<div class="tp-card tp-sessions tp-lazy" data-lazy="sessions" data-contract="${esc(id)}">
            <div class="tp-card-title">
                <span class="tp-dot"></span>Сессия и подключение
                <span class="tp-sess-state" data-role="sess-state"></span>
                <span class="tp-live" title="Обновляется автоматически"><span class="tp-dot-live"></span>Автообновление</span>
            </div>
            <div class="tp-lazy-body">${skeleton(2)}</div>
        </div>`;

        const eqCard = `<div class="tp-card tp-lazy" data-lazy="equipment">
            <div class="tp-card-title"><span class="tp-dot"></span>Оборудование</div>
            <div class="tp-lazy-body">${skeleton(1)}</div>
        </div>`;

        /*
         * «Отправить на почту» — выдача доступов абоненту письмом.
         *
         * Стоит сразу под «Оборудованием»: это тоже действие с абонентом,
         * а не справочные данные. Данные для письма (логин и пароль PPPoE,
         * пароль статистики, адрес получателя) подставляются сами — оператору
         * остаётся выбрать, что отправлять, и нажать кнопку.
         *
         * Устройство ERP: письмо — это сообщение процесса. Поэтому за кулисами
         * создаётся обращение «1 Линия», в нём сообщение, и обращение сразу
         * закрывается (см. ERP.createProcess / sendProcessMessage / closeProcess).
         */
        const mailCard = `<div class="tp-card tp-mail tp-lazy" data-lazy="mail">
            <div class="tp-card-title">
                <span class="tp-dot"></span>Отправить на почту
            </div>
            <div class="tp-lazy-body">${skeleton(3)}</div>
        </div>`;

        /*
         * «Процессы» — обращения и заявки, привязанные к договору.
         *
         * Раньше за ними нужно было уходить на вкладку «Процессы» карточки и
         * терять контекст разговора с абонентом. Здесь видно главное: есть ли
         * незакрытое обращение (его ещё кто-то ведёт) и что было закрыто.
         *
         * Две вкладки — «Активные» и «Закрытые». Это родные фильтры ERP
         * (параметр open=1/0 в linkedProcessList), поэтому содержимое совпадает
         * с вкладкой «Процессы» один в один, без собственной фильтрации по
         * тексту статуса — та ломалась бы на любом новом статусе в биллинге.
         */
        const processesCard = `<div class="tp-card tp-processes tp-lazy" data-lazy="processes" data-contract="${esc(id)}">
            <div class="tp-card-title">
                <span class="tp-dot"></span>Процессы
                <span class="tp-proc-state" data-role="proc-state"></span>
            </div>
            <div class="tp-lazy-body">${skeleton(2)}</div>
        </div>`;

        /*
         * «Сервисы» — техническая карточка договора в биллинге.
         *
         * Скрипт запрашивал дерево сервисов (inet.do?method=serviceTree) сразу
         * в трёх местах — ради типа подключения для сессий, для «Белого IP» и
         * для закрытия старого сервиса, — но оператору этот список не показывал.
         * А он нужен: видно, есть ли открытый сервис вообще, с какого числа,
         * на каком устройстве и не осталось ли «удалённых» записей, которые
         * мешают создать новый сервис с тем же логином.
         */
        const servicesCard = `<div class="tp-card tp-lazy tp-fold" data-lazy="services">
            <details>
                <summary class="tp-card-title"><span class="tp-dot"></span>Сервисы в биллинге<span class="tp-fold-caret"></span></summary>
                <div class="tp-lazy-body">${skeleton(3)}</div>
            </details>
        </div>`;

        /*
         * Три колонки по зонам ответственности, а не по типам данных:
         *   слева  — всё абонентское (кто он, за что платит, сколько должен, история);
         *   центр  — действия с абонентом (деньги и доверительный платёж);
         *   справа — техника (сессии с доступами, ошибки, оборудование).
         * Так оператор ищет блок по задаче, а не вспоминает, к какой категории
         * разработчик отнёс данные.
         */
        return `<div class="tp-wrap" data-contract="${esc(id)}">
            <div class="tp-layout tp-layout-3">
                <div class="tp-col tp-col-client">
                    ${clientTariffCard}
                    ${statusCard}
                    ${payCard}
                </div>
                <div class="tp-col tp-col-actions">
                    ${actionsCard}
                    ${limitCard}
                    ${whiteIpCard}
                    ${memoCard}
                </div>
                <div class="tp-col tp-col-tech">
                    ${sessionsCard}
                    ${servicesCard}
                    ${eqCard}
                    ${processesCard}
                    ${mailCard}
                </div>
            </div>
        </div>`;
    }

    /**
     * Скорость из состава тарифа: ищем строку вида «100 Мбит/с» / «До 1 Гбит/с»
     * в названиях услуг тарифа (публичного поля скорости в карточке нет).
     */
    /* --------------------------------------------------------------- UI glue */

    /* ------------------------------------------------------------ sessions UI */

    // Всё состояние сессий живёт на контейнере карточки (dataset), а не в модулях:
    // иначе у двух открытых договоров общий вид списка, общий Set «новых» сессий и один таймер.

    const sessKindOf = (container) => container.dataset.kind || 'alive';

    const knownSetOf = (container) =>
        new Set((container.dataset.known ? container.dataset.known.split('\n') : []).filter(Boolean));

    const setKnown = (container, rows) => {
        container.dataset.known = rows.map(sessKey).join('\n');
    };

    /** Поколение данных — своё у каждой панели: перерисовка одной не гасит ответы другой. */
    const genOf = (panel) => panel.dataset.gen || '';

    const sessKey = (r) => `${r.conId}|${r.start}|${r.ip}`;

    function renderSessions(container, data, isFirst) {
        const rows = (data && data.rows) || [];
        const body = container.querySelector('.tp-sess-body');
        if (!body) return;

        const kind = sessKindOf(container);
        const known = knownSetOf(container);
        // renderSessions получает только контейнер, а счётчики живут на панели
        const panel = container.closest(PANEL_SEL);

        // Счётчики вкладок. У «Активных» число видно всегда, у «Истории» —
        // когда она загружена (фоном или по клику), у «Ошибок» — из их данных.
        if (panel) {
            if (kind === 'alive') panel._tpAliveCount = rows.length;
            if (kind === 'history') panel._tpHistoryCount = rows.length;
            applyTabCounts(panel);
        }
        if (kind === 'alive') {
            const stateEl = container.querySelector('[data-role="sess-state"]');
            if (stateEl) {
                stateEl.className = 'tp-sess-state ' + (rows.length ? 'is-on' : 'is-off');
                stateEl.textContent = rows.length ? 'Онлайн' : 'Офлайн';
            }
        }

        if (!rows.length) {
            setHtmlIfChanged(body, `<div class="tp-sess-empty">${kind === 'history'
                ? 'В этом месяце сессий не было.'
                : 'Активных сессий нет — абонент не подключён.'}</div>`);
            setKnown(container, []);
            return;
        }

        let html = '';
        // История — от новых к старым (BGBilling отдаёт хронологически, снизу вверх)
        const ordered = kind === 'history' ? rows.slice().reverse() : rows;
        ordered.slice(0, 30).forEach((r) => {
            const isNew = !isFirst && !known.has(sessKey(r));
            const stateBadge = /отключ/i.test(r.state || '') ? '<span class="tp-badge is-bad">отключено</span>'
                : /подключ/i.test(r.state || '') ? '<span class="tp-badge is-ok">подключено</span>' : '';
            const typeChip = r.connType ? `<span class="tp-chip is-xs">${esc(r.connType)}</span>` : '';
            // ERP кладёт в «Сервис» номер договора и IP, которые уже показаны ниже
            // строкой «IP … · устройство». Оставляем только имя сервиса.
            // Заглушку [IpAddress:null] тоже выкидываем: она приходит из шаблона
            // имени биллинга, пока сервису не выдан адрес.
            const serviceName = cleanBillServiceName(r.service, { dropLogin: true, dropAddr: true });

            html += `<div class="tp-sess-row ${isNew ? 'tp-fresh' : ''}">
                <div class="tp-sess-main">
                    <div class="tp-sess-svc">${esc(serviceName || 'Интернет')} ${typeChip} ${stateBadge}</div>
                    <div class="tp-sess-meta">
                        IP ${esc(r.ip || '—')} · ${esc(r.device || '—')}<br>
                        ${kind === 'history'
                            ? `${esc(r.start)} → ${esc(r.end || '—')} · ${esc(r.status || '')}`
                            : `с ${esc(r.start)} · ${esc(r.status || '')}`}
                        ${r.traffic ? `<br>трафик ${esc(r.traffic)} Мб` : ''}
                    </div>
                    <div class="tp-sess-status"></div>
                </div>
                ${kind === 'alive' && r.conId
                    ? `<div class="tp-sess-actions">
                           <button type="button" class="tp-sess-btn" data-con="${esc(r.conId)}"
                                   data-state="${/отключ/i.test(r.state || '') ? 'off' : 'on'}"
                                   title="${/отключ/i.test(r.state || '')
                                       ? 'Сессия уже отключена на BRAS — закрыть только запись в биллинге'
                                       : 'Сброс на BRAS, затем закрытие записи в биллинге'}">${/отключ/i.test(r.state || '') ? 'Закрыть в БД' : 'Сбросить'}</button>
                       </div>`
                    : ''}
            </div>`;
        });

        if (rows.length > 30) {
            html += `<div class="tp-hint">Показаны 30 из ${esc(data.total)} записей.</div>`;
        }

        setHtmlIfChanged(body, html);
        setKnown(container, rows);
    }
    /**
     * Загрузка сессий конкретного договора.
     * cid берётся из data-contract самой карточки — иначе при переключении договора
     * таймер старой панели запросил бы сессии нового и нарисовал их в старой.
     * Возвращает данные (или null), чтобы автообновление могло обновить ещё и
     * «Состояние связи» — без повторного запроса тех же сессий.
     */
    async function loadSessions(container, showLoading) {
        const body = container.querySelector('.tp-sess-body');
        if (!body) return null;

        const panel = container.closest(PANEL_SEL);
        const cid = container.dataset.contract || (panel && panel.dataset.contractId) || '';
        if (!cid) return null;

        const generation = panel ? genOf(panel) : '';
        // Показ «Загрузка…» пишем напрямую, поэтому кэш сравниваемого HTML
        // обязательно сбрасываем. Иначе setHtmlIfChanged помнит ПРЕЖНЮЮ
        // разметку, считает новую «такой же» и не перерисовывает её: на экране
        // навсегда остаётся «Загрузка…». Воспроизводилось так: История →
        // Ошибки → История (данные те же, значит сравнение даёт «не изменилось»).
        if (showLoading) {
            body.__tpHtml = null;
            body.innerHTML = '<div class="tp-loading" style="padding:8px">Загрузка…</div>';
        }

        try {
            const data = await ERP.sessions(sessKindOf(container), cid);
            // Пока шёл запрос, панель перерисовали — ответ устарел
            if (panel && genOf(panel) !== generation) return null;
            if (!document.contains(container)) return null;
            renderSessions(container, data, showLoading);
            return data;
        } catch (e) {
            if (panel && genOf(panel) !== generation) return null;
            if (!document.contains(container)) return null;
            body.__tpHtml = null;
            body.innerHTML = `<div class="tp-err">Не удалось загрузить сессии: ${esc(e.message || e)}</div>`;
            return null;
        }
    }

    /** initialData — уже полученные активные сессии (не дёргаем тот же запрос второй раз). */
    function mountSessions(panel, initialData) {
        const container = panel.querySelector('.tp-sessions');
        if (!container) return;

        // Кнопки ещё не отрисованы (скелетон) — подождём следующего вызова
        if (!container.querySelector('.tp-tabs-mini button')) return;

        const contractId = container.dataset.contract
            || (panel.dataset.contractId)
            || ERP.contractId(panel.closest('#content > div[id^="contract_bill-"]'));
        if (!contractId) return;

        if (container.dataset.bound === contractId) return;
        container.dataset.bound = contractId;
        container.dataset.kind = 'alive';
        container.dataset.known = '';

        // Переключение Активные / История / Ошибки
        container.querySelectorAll('.tp-tabs-mini button').forEach((btn) => {
            btn.addEventListener('click', () => {
                container.querySelectorAll('.tp-tabs-mini button').forEach((b) => b.classList.remove('is-on'));
                btn.classList.add('is-on');
                const kind = btn.dataset.kind || 'alive';
                container.dataset.kind = kind;
                container.dataset.known = '';

                // Ошибки живут в своём контейнере: их не надо перезапрашивать
                // при каждом переключении, они уже загружены автообновлением.
                const sessBody = container.querySelector('.tp-sess-body');
                const errBody = container.querySelector('.tp-err-body');
                const isErr = kind === 'errors';
                if (sessBody) sessBody.hidden = isErr;
                if (errBody) errBody.hidden = !isErr;

                if (!isErr) loadSessions(container, true);
            });
        });

        // Закрытие сессии одной кнопкой: сначала сброс на BRAS, затем завершение в БД
        container.addEventListener('click', async (ev) => {
            const btn = ev.target.closest('.tp-sess-btn');
            if (!btn) return;
            const conId = btn.dataset.con;
            if (!conId) return;

            const row = btn.closest('.tp-sess-row');
            const statusEl = row ? row.querySelector('.tp-sess-status') : null;
            const original = btn.textContent;
            btn.disabled = true;

            const setStatus = (cls, text) => {
                if (!statusEl) return;
                statusEl.className = 'tp-sess-status ' + cls;
                statusEl.textContent = text;
            };

            try {
                // Сессия уже отключена на BRAS — PoD не нужен, только закрываем запись
                if (btn.dataset.state === 'off') {
                    btn.textContent = 'Завершение…';
                    const onlyFinish = await ERP.resetSession(conId, 'finish');
                    if (onlyFinish.ok) {
                        setStatus('is-ok', onlyFinish.already
                            ? 'Запись уже была закрыта — список обновлён'
                            : 'Запись закрыта в БД');
                        btn.textContent = 'Готово';
                        setTimeout(() => loadSessions(container, false), 1200);
                    } else {
                        setStatus('is-bad', 'Не удалось закрыть запись: ' + (onlyFinish.message || ''));
                        btn.disabled = false;
                        btn.textContent = original;
                    }
                    return;
                }

                // 1) Сброс соединения на BRAS (PoD/CoA)
                btn.textContent = 'Сброс…';
                const closeRes = await ERP.resetSession(conId, 'close');

                if (!closeRes.ok) {
                    // BRAS действительно отказал — дальше не идём, показываем причину
                    setStatus('is-bad', 'PoD не прошёл: ' + (closeRes.message || 'BRAS не ответил'));
                    btn.disabled = false;
                    btn.textContent = original;
                    return;
                }

                // Биллинг уже не знает такую сессию — она закрыта, повторно ничего не делаем
                if (closeRes.already) {
                    setStatus('is-ok', 'Сессия уже завершена — список обновлён');
                    btn.textContent = 'Закрыта';
                    setTimeout(() => loadSessions(container, false), 1200);
                    return;
                }

                // 2) Завершение записи в биллинге
                btn.textContent = 'Завершение…';
                const finishRes = await ERP.resetSession(conId, 'finish');

                if (finishRes.ok) {
                    setStatus('is-ok', finishRes.already
                        ? 'Сброшено на BRAS · запись уже была закрыта'
                        : 'Сброшено на BRAS · закрыто в БД');
                    btn.textContent = 'Готово';
                    setTimeout(() => loadSessions(container, false), 1200);
                } else {
                    setStatus('is-bad', 'Сброшено на BRAS, но запись не закрыта: ' + (finishRes.message || ''));
                    btn.disabled = false;
                    btn.textContent = original;
                }
            } catch (e) {
                setStatus('is-bad', 'Ошибка: ' + (e.message || e));
                btn.disabled = false;
                btn.textContent = original;
            }
        });

        if (initialData) renderSessions(container, initialData, true);
        else loadSessions(container, true);

        // Автообновление «Сессии» и «Ошибок». Деньги и доступы сюда не входят:
        // баланс и пароли меняются не по секундам, а лишние запросы к ERP — это
        // нагрузка на биллинг.
        mountAutoRefresh(panel);
    }

    /** Интервал автообновления связанных блоков, мс. */
    const AUTO_REFRESH_MS = 7000;
    /** Раз во сколько тиков обновляем «медленные» данные (история, доступы). */
    const AUTO_SLOW_EVERY = 6;

    /**
     * Автообновление «Сессия» + «Ошибки».
     *
     * Таймер один на панель и живёт на самой панели (panel._tpAutoTimer):
     * у двух открытых договоров не должно быть общего таймера, иначе один
     * договор опрашивается дважды, а другой не опрашивается вовсе.
     *
     * Запросы не гоняем, когда вкладка браузера скрыта или панель не видна
     * (ERP держит карточки через display:none — открыт другой договор или процесс).
     *
     * Тик — цепочка setTimeout, а не setInterval: пока ERP отвечает медленно
     * (а она отвечает медленно), интервальный таймер успевал накопить очередь
     * запросов, и вкладка начинала тормозить. Следующий тик ставится только
     * после того, как закончился предыдущий.
     *
     * Медленные данные (счётчик истории, доступы) обновляем редко: пароль
     * за 40 секунд не меняется, а запрос к contractCards — один из самых тяжёлых.
     */
    function mountAutoRefresh(panel) {
        if (!panel) return;
        // Идемпотентно: mountSessions вызывается из нескольких мест, и повторный
        // вызов не должен сбрасывать уже идущий таймер.
        if (panel._tpAutoTimer || panel._tpAutoStop) return;

        let ticks = 0;
        let stopped = false;
        // Защита от наложения: visibilitychange может прийти, пока предыдущий
        // тик ещё ждёт ответа ERP. Второй параллельный опрос не нужен.
        let running = false;

        const stop = () => {
            stopped = true;
            if (panel._tpAutoTimer) { clearTimeout(panel._tpAutoTimer); panel._tpAutoTimer = null; }
            document.removeEventListener('visibilitychange', onVisible);
        };

        // Вернулись на вкладку — обновляем сразу, не ждём конца интервала
        const onVisible = () => {
            if (stopped || document.hidden || running) return;
            if (panel._tpAutoTimer) { clearTimeout(panel._tpAutoTimer); panel._tpAutoTimer = null; }
            tick();
        };

        const plan = (delay) => {
            if (stopped) return;
            if (panel._tpAutoTimer) clearTimeout(panel._tpAutoTimer);
            panel._tpAutoTimer = setTimeout(tick, delay);
        };

        const tick = async () => {
            panel._tpAutoTimer = null;
            if (running) return;
            running = true;

            try {
                if (!document.contains(panel)) { stop(); return; }
                // Скрытая вкладка или неактивная карточка — работы нет, но тик
                // продолжаем планировать: вернёмся на страницу — данные оживут сами.
                if (document.hidden || panel.offsetParent === null) { plan(AUTO_REFRESH_MS); return; }

                const cid = panel.dataset.contractId;
                if (!cid) { plan(AUTO_REFRESH_MS); return; }

                const generation = genOf(panel);
                const slow = (ticks += 1) % AUTO_SLOW_EVERY === 0;

                /*
                 * Сессии и ошибки — параллельно, а не по очереди. Раньше здесь
                 * стояло `await sessionsPromise; await errorsPromise;` — то есть
                 * тик ждал сначала один блок, потом другой, хотя комментарий
                 * рядом обещал независимость. Ошибки Radius — пять запросов
                 * с пагинацией, и сессии простаивали всё это время.
                 *
                 * Ошибки Radius идут в МЕДЛЕННЫЙ круг: их TTL 40 с, а тик — 7 с,
                 * поэтому пять ответов разбирались заново вхолостую шесть раз
                 * из семи. Счётчик ошибок подключения не меняется посекундно,
                 * оператору он нужен с точностью до минуты.
                 */
                const sessionsCard = panel.querySelector('.tp-sessions');
                const sessionsPromise = sessionsCard
                    ? loadSessions(sessionsCard, false).catch(() => null)
                    : Promise.resolve(null);

                const errorsPromise = slow
                    ? loadRadiusErrors(panel, cid).catch(() => null)
                    : Promise.resolve(null);

                try {
                    await Promise.allSettled([sessionsPromise, errorsPromise]);
                    if (genOf(panel) !== generation || !document.contains(panel)) { plan(AUTO_REFRESH_MS); return; }

                    // Медленный круг: доступы (пароль могли сменить в биллинге)
                    // и счётчик истории — цифра на вкладке не должна устаревать навсегда.
                    if (slow && genOf(panel) === generation && document.contains(panel)) {
                        await Promise.all([
                            loadAccesses(panel, cid).catch(() => null),
                            loadHistoryCount(panel, cid).catch(() => null),
                        ]);
                    }
                } catch (e) { /* сеть моргнула — следующий тик попробует снова */ }

                plan(AUTO_REFRESH_MS);
            } finally {
                running = false;
            }
        };

        document.addEventListener('visibilitychange', onVisible);
        panel._tpAutoStop = stop;
        panel._tpAutoTimer = setTimeout(tick, AUTO_REFRESH_MS);
    }

    /** Остановка автообновления панели (перед перерисовкой или сносом карточки). */
    function stopAutoRefresh(panel) {
        if (!panel) return;
        if (typeof panel._tpAutoStop === 'function') {
            try { panel._tpAutoStop(); } catch (e) { /* таймера уже нет */ }
            panel._tpAutoStop = null;
        }
        if (panel._tpAutoTimer) { clearTimeout(panel._tpAutoTimer); panel._tpAutoTimer = null; }
    }

    /**
     * Копирование в буфер с запасным путём.
     *
     * navigator.clipboard требует защищённого контекста и разрешения; в ERP
     * (http, вставка в чужую страницу) он может быть недоступен. Тогда —
     * скрытая textarea и execCommand, который работает везде.
     */
    function copyToClipboard(value, done) {
        const text = String(value == null ? '' : value);
        const fallback = () => {
            const ta = document.createElement('textarea');
            ta.value = text;
            // Вне экрана: иначе страница дёргается к вставленному узлу
            ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand('copy'); } catch (e) { /* браузер запретил */ }
            ta.remove();
            if (done) done();
        };

        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(() => { if (done) done(); }, fallback);
        } else {
            fallback();
        }
    }

    /**
     * Копирование по клику с подтверждением.
     *
     * Оператор должен видеть, что скопировалось. Значение на 900 мс меняется
     * на «Скопировано: 94.241» и зеленеет — так видно и сам факт, и то, что
     * попало в буфер. Текст возвращаем из dataset, а не из замыкания: панель
     * перерисовывается (автообновление раз в 7 секунд), и старый узел может
     * быть уже заменён новым.
     */
    function bindCopyTargets(root) {
        const scope = root || document;
        scope.querySelectorAll('[data-tp-copy]').forEach((el) => {
            if (el.dataset.tpCopyBound === '1') return;
            el.dataset.tpCopyBound = '1';

            // Исходный текст — в data-атрибуте, чтобы возврат работал
            // независимо от того, сколько раз нажали
            if (el.dataset.tpLabel == null) el.dataset.tpLabel = el.textContent;

            el.addEventListener('click', (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                const value = el.dataset.tpCopy || '';
                if (!value) return;

                copyToClipboard(value, () => {
                    // Повторный клик во время показа: сначала вернуть текст,
                    // иначе в dataset.tpLabel попадёт «Скопировано: …»
                    if (el._tpCopyTimer) {
                        clearTimeout(el._tpCopyTimer);
                        el.textContent = el.dataset.tpLabel;
                    }
                    el.textContent = 'Скопировано: ' + value;
                    el.classList.add('is-copied');
                    el._tpCopyTimer = setTimeout(() => {
                        el.textContent = el.dataset.tpLabel;
                        el.classList.remove('is-copied');
                        el._tpCopyTimer = null;
                    }, 900);
                });
            });
        });
    }

    /** Копирование пароля по клику — с подсказкой «Скопировано». */
    function mountPasswords(panel) {
        panel.querySelectorAll('.tp-pwd-val[data-pwd]').forEach((el) => {
            if (el.dataset.bound === '1') return;
            el.dataset.bound = '1';

            el.addEventListener('click', () => {
                const value = el.dataset.pwd || '';
                if (!value) return;

                const done = () => {
                    const old = el.textContent;
                    el.textContent = 'Скопировано';
                    setTimeout(() => { el.textContent = old; }, 900);
                };

                copyToClipboard(value, done);
            });
        });
    }

    /* ---------------------------------------------------- background hydrate */

    /** Заполняет карточку-плейсхолдер готовым HTML. */
    function fillLazy(panel, name, html) {
        const card = panel.querySelector(`.tp-lazy[data-lazy="${name}"]`);
        if (!card) return;
        const body = card.querySelector('.tp-lazy-body');
        if (!body) return;
        setHtmlIfChanged(body, html);
        card.classList.add('is-filled');
    }

    /* ------------------------------------------------------------- белый IP */

    /**
     * Блок «Белый IP»: текущие публичные адреса и выдача нового.
     *
     * Устройство белого IP в этом биллинге:
     *  - адрес берётся из категории IP-ресурсов «IPoE белые»
     *    (документация BGBilling: IP-ресурсы, 43385952);
     *  - выдаётся сервисом IPoE (typeId=2) через статический addrFrom
     *    (документация: Сервисы, 43385982);
     *  - «тестовый» — отдельный сервис с новым логином/паролем, старый
     *    закрывается вчерашним числом, чтобы не рвать текущие сутки;
     *  - «обычный» — сервис с публичным адресом, услуга «Публичный IP-адрес»
     *    или «(юрлица)» уже входит в абонплату тарифа.
     */
    function renderWhiteIp(state) {
        const { current, free, personType, devices, deviceId, svcType, creds } = state || {};
        const isLegal = personType === 'legal';
        const devs = devices || [];
        const isIpoe = (svcType || 'pppoe') === 'ipoe';
        // Для IPoE устройство обязательно; PPPoE берёт его из конфигурации типа
        const selectedDev = deviceId || (devs[0] || {}).id || '';

        const ipKind = (state && state.ipKind) || 'none';       // white | grey | none
        const currentIp = (state && state.currentIp) || '';
        const hasService = !!(state && state.npay);
        // Тип по умолчанию — «Тестовый»: белый IP выдают на пробу, а с услугой
        // в абонплате оформляют уже после согласия абонента. Раньше первым
        // стоял «Обычный», и оператор по инерции вешал платный адрес.
        //
        // Сохранённый выбор оператора важнее умолчания: без этого после каждой
        // перерисовки панели селект прыгал обратно на «Тестовый», и человек
        // терял то, что выбрал. Значение живёт на панели до её пересборки.
        const kind = (state && state.kind) || 'test';

        let html = '';

        // ---- состояние подключения: белый или серый адрес и услуга в абонплате
        //
        // Оператору важно видеть это сразу: «белый» без услуги — абонент получает
        // публичный адрес, но за него не платит; «серый» при подключённой услуге —
        // платит, а адреса нет. Оба случая — повод разобраться.
        const ipLabel = ipKind === 'white' ? 'Белый IP'
            : ipKind === 'grey' ? 'Серый IP'
                : 'Нет подключения';
        html += `<div class="tp-whiteip-status">
            <span class="tp-whiteip-state is-${ipKind}">${esc(ipLabel)}${currentIp ? ' · ' + esc(currentIp) : ''}</span>
            <span class="tp-whiteip-state ${hasService ? 'is-ok' : 'is-off'}">${hasService
                ? 'Услуга «Публичный IP' + (isLegal ? ' (юрлица)' : '') + '» подключена'
                : 'Услуга не подключена'}</span>
        </div>`;

        // ---- что уже выдано
        if (current && current.length) {
            html += '<div class="tp-whiteip-list">';
            current.forEach((c) => {
                html += `<div class="tp-whiteip-row">
                    <span class="tp-whiteip-ip">${esc(c.ip || '—')}</span>
                    <span class="tp-whiteip-meta">${esc(c.login || '')}${c.period ? ' · ' + esc(c.period) : ''}</span>
                </div>`;
            });
            html += '</div>';
        } else {
            html += '<div class="tp-hint">Публичного адреса нет.</div>';
        }

        // ---- форма выдачи
        //
        // Адрес не выбирается: берётся первый свободный из пула своего типа.
        // PPPoE — логин и пароль из договора (их видит абонент в роутере).
        // IPoE — устройство и адрес автоматически, MAC вводится вручную,
        //        потому что авторизация там по MAC роутера.
        // Селект «Тип» — это выбор действия, а не только вида адреса.
        //
        // Раньше рядом стояли четыре кнопки, и две из них делали одно и то же:
        // «Навесить серый IP» и «Убрать белый IP» обе закрывали белый сервис и
        // создавали серый, разница была только в позиции абонплаты. Оператор
        // выбирал между ними наугад. Теперь услуга при снятии белого IP всегда
        // удаляется, и два действия слились в одно — «Серый».
        html += `<div class="tp-whiteip-form">
            <label class="tp-field">
                <span>Тип</span>
                <select class="tp-whiteip-kind">
                    <option value="test"${kind === 'regular' || kind === 'grey' ? '' : ' selected'}>Тестовый</option>
                    <option value="regular"${kind === 'regular' ? ' selected' : ''}>С услугой${isLegal ? ' (юрлица)' : ''}</option>
                    <option value="grey"${kind === 'grey' ? ' selected' : ''}>Серый</option>
                </select>
            </label>
            <label class="tp-field">
                <span>Подключение</span>
                <select class="tp-whiteip-svc">
                    <option value="pppoe"${isIpoe ? '' : ' selected'}>PPPoE</option>
                    <option value="ipoe"${isIpoe ? ' selected' : ''}>IPoE</option>
                </select>
            </label>`;

        // Устройство для IPoE фиксировано — BRAS-004, выбирать нечего.
        const chosen = (devs.find((d) => String(d.id) === String(selectedDev)) || devs[0] || null);
        html += `<div class="tp-whiteip-dev-wrap tp-whiteip-dev-fixed"${isIpoe ? '' : ' hidden'}>
                <span class="tp-whiteip-dev-label">Устройство</span>
                <span class="tp-whiteip-dev-name">${esc(chosen ? chosen.title : 'BRAS-004 не найдено')}</span>
                <input type="hidden" class="tp-whiteip-device" value="${esc(chosen ? chosen.id : '')}">
            </div>`;

        // MAC роутера — только для IPoE, вводится вручную.
        html += `<label class="tp-field tp-whiteip-mac-wrap"${isIpoe ? '' : ' hidden'}>
                <span>MAC роутера</span>
                <input type="text" class="tp-whiteip-mac" placeholder="a4ba.7002.8a61"
                       value="${esc((creds && creds.mac) || '')}">
            </label>`;

        // Логин и пароль — из договора, для сверки с роутером абонента.
        //
        // Пароль показываем в поле ввода, а не текстом: он подставлен из договора,
        // но оператор может его поправить перед созданием сервиса (например,
        // абонент забыл пароль и просит поставить свой). Правка действует только
        // на создаваемый сервис — старый пароль от этого не меняется.
        //
        // Логин оставляем только для чтения: это номер договора, и ровно он
        // приходит в RADIUS как User-Name. Изменив его, оператор получил бы
        // сервис, который роутер абонента никогда не найдёт.
        const credsLogin = (creds && creds.login) || '';
        const credsPwd = (creds && creds.password) || '';
        html += `<div class="tp-whiteip-creds"${isIpoe ? ' hidden' : ''}>
                <div class="tp-whiteip-creds-row">
                    <div class="tp-field">
                        <span>Логин</span>
                        <div class="tp-whiteip-cred-value${credsLogin ? '' : ' is-bad'}"
                             title="Логин — номер договора, изменить нельзя">${credsLogin
                            ? esc(credsLogin) : 'логина нет'}</div>
                    </div>
                    <label class="tp-field">
                        <span>Пароль</span>
                        <input type="text" class="tp-whiteip-password" value="${esc(credsPwd)}"
                               placeholder="${credsPwd ? '' : 'пароль не заполнен'}">
                    </label>
                </div>
                <span class="tp-whiteip-cred-hint${credsPwd ? '' : ' is-bad'}">${credsPwd
                    ? 'Пароль из договора — можно изменить, сервис создастся с этим паролем.'
                    : 'Пароля в договоре нет: впишите свой или оставьте пустым — биллинг сгенерирует.'}</span>
            </div>`;

        // Адрес не показываем: оператору он не нужен, скрипт берёт первый
        // свободный из пула своего типа. Значение держим в скрытом поле,
        // чтобы обработчик кнопки не ходил за ним повторно.
        const autoAddr = (free || [])[0] || '';
        // Свободный серый нужен для действия «Серый» — там адрес тоже
        // подставляется автоматически. В форме его не показываем.
        const greyAddr = (state && state.greyFree && state.greyFree[0]) || '';

        // Одна кнопка вместо четырёх. Подпись и доступность зависят от того,
        // что выбрано в «Типе»: белый пул и серый пул — разные ресурсы, и
        // «Применить» не должно быть активным, когда нужного адреса нет.
        const isGreyKind = kind === 'grey';
        const canApply = isGreyKind ? !!greyAddr : !!autoAddr;
        const applyLabel = isGreyKind ? 'Навесить серый IP' : 'Навесить белый IP';

        html += `<input type="hidden" class="tp-whiteip-addr" value="${esc(autoAddr)}">
            <button type="button" class="tp-btn tp-whiteip-apply"${canApply ? '' : ' disabled'}
                    data-grey="${esc(greyAddr)}">${esc(applyLabel)}</button>
            <span class="tp-msg tp-whiteip-msg"></span>
        </div>`;

        return html;
    }

    /**
     * Загрузка состояния блока: текущие белые адреса, свободные адреса,
     * тип лица. Всё параллельно — блок ждёт самый медленный запрос.
     */
    async function loadWhiteIp(panel, cid) {
        const generation = genOf(panel);
        const id = cid || panel.dataset.contractId;
        if (!id) return null;

        // Тип подключения по умолчанию — по АКТИВНОМУ сервису договора.
        // Раньше смотрели на любой PPPoE, включая закрытые, и на договоре
        // с давно закрытым PPPoE выбирался PPPoE-пул вместо нужного IPoE.
        // Пулы у типов разные: «PPPoE белые» и «IPoE белые».
        // Дерево сервисов уже могло быть загружено блоком «Сервисы» — берём его.
        const svc = await erpOnce(panel, 'services', () => ERP.services(id))
            .catch(() => ({ list: [] }));
        const active = (svc.list || []).filter((s) => isAliveService(s));
        const hasActivePppoe = active.some((s) => /PPPoE/i.test(s.type || ''));
        const hasActiveIpoe = active.some((s) => /IPoE/i.test(s.type || ''));
        // Есть активный IPoE — он и главный (белый IP живёт на нём). Иначе PPPoE.
        const svcType = hasActiveIpoe ? 'ipoe' : (hasActivePppoe ? 'pppoe' : 'pppoe');
        const typeId = svcType === 'ipoe' ? 2 : 1;

        const [free, personType, devices, creds] = await Promise.all([
            // Сессию не глушим: пустой список свободных адресов оператор прочитает
            // как «адреса кончились», а не как «нужно войти заново».
            ERP.freeIpList(id, typeId).catch((e) => {
                if (/Сессия ERP истекла/.test(e.message || '')) throw e;
                return [];
            }),
            Promise.resolve(ERP.personType(id)),
            ERP.devices().catch(() => []),
            ERP.activeCredentials(id).catch(() => null),
        ]);

        // Настройки действующего сервиса: MAC и устройство нужны для возврата
        // на серый IP тем же типом подключения, без повторного ввода оператором.
        const activeInet = await ERP.activeInetService(id).catch(() => null);

        if (genOf(panel) !== generation) return null;
        if (!document.contains(panel)) return null;

        // Текущие публичные адреса.
        //
        // Раньше брали любой сервис с адресом в названии — из-за этого сверху
        // висели закрытые сервисы с серыми адресами (10.100.x). Теперь только:
        //  - сервис не закрыт и не удалён (иначе это история, а не текущее);
        //  - адрес публичный: 10.0.0.0/8 — серая сеть, для белого IP не годится.
        // Сама проверка — isPublicIp() на уровне модуля: её же использует
        // обновление после выдачи/снятия адреса.

        const current = (svc.list || [])
            .filter((s) => /IPoE|PPPoE/i.test(s.type || ''))
            .filter((s) => isAliveService(s))
            .map((s) => {
                const ip = (String(s.name || '').match(/(\d{1,3}(?:\.\d{1,3}){3})/) || [])[1] || '';
                return {
                    ip,
                    login: String(s.name || '').replace(/\s*\d{1,3}(?:\.\d{1,3}){3}\s*/g, ' ').trim(),
                    period: s.period || '',
                };
            })
            .filter((c) => isPublicIp(c.ip));

        // Свободные — только из «белых» категорий
        const whiteCats = (free || []).filter((c) => c.isWhite);
        const ips = whiteCats.flatMap((c) => c.ips);

        // Свободные серые адреса: нужны, чтобы вернуть абонента на серый IP
        // конкретным адресом. Пустой addrFrom биллинг принимает, но адрес
        // не выдаёт — сервис остаётся с 0.0.0.0 и заглушкой [IpAddress:null].
        const greyIps = (free || [])
            .filter((c) => !c.isWhite)
            .flatMap((c) => c.ips)
            .filter((ip) => !isPublicIp(ip));

        // Есть ли услуга «Публичный IP-адрес» в абонплате.
        // Это отдельный модуль (npay), в составе тарифа её не видно,
        // поэтому проверяем запросом, а не по данным «Стоимости».
        const isLegal = personType === 'legal';
        const npaySvc = await findPublicIpNpayService(id, isLegal).catch(() => null);

        // Текущее состояние подключения:
        //  • белый IP — активный сервис со статическим публичным адресом;
        //  • серый IP — активный сервис без публичного адреса (адрес из серой сети
        //    или его нет вовсе — тогда адрес выдаётся динамически).
        const activeSvc = active.find((s) => /IPoE|PPPoE/i.test(s.type || '')) || null;

        // Адрес действующего сервиса берём из его карточки (addrFrom), а не
        // только из названия. IPoE-сервисы называются «Интернет (BRAS-004)»
        // и адрес в имени не содержат — раньше из-за этого белый IP
        // показывался как «серый, адреса нет».
        if (activeInet && isPublicIp(activeInet.addr)
            && !current.some((c) => c.ip === activeInet.addr)) {
            current.unshift({
                ip: activeInet.addr,
                login: (creds && creds.login) || '',
                period: (activeSvc && activeSvc.period) || '',
            });
        }

        const currentIp = current.length ? current[0].ip : '';
        const ipKind = currentIp ? 'white' : (activeSvc ? 'grey' : 'none');

        // Устройство зависит от типа подключения:
        //  - IPoE — фиксировано BRAS Microtik BRAS-004 (MAC-авторизация);
        //  - PPPoE — папка PPPoE из дерева устройств. Именно к ней привязаны
        //    PPPoE-сервисы, и только с ней применяется статический адрес
        //    из «PPPoE белые»; с IPoE-устройством биллинг отвечает
        //    «Подходящий ip ресурс не найден».
        const BRAS_004 = /BRAS-004/i;
        const PPPOE_FOLDER = /Папка:\s*PPPoE/i;

        const ipoeDev = (devices || []).find((d) => BRAS_004.test(d.title))
            || (devices || [])[0] || null;

        // Папку PPPoE в отфильтрованном списке нет — ERP не отдаёт её как
        // устройство с адресом. Поэтому берём её отдельным запросом.
        let pppoeDevId = '';
        try {
            const tree = await fetchText(
                '/user/plugin/bgbilling/proto/inet.do?method=devicesGet'
                + '&billingId=bill&moduleId=1&deviceId=0&deviceTypeIds=&deviceGroupIds='
            );
            const treeBody = parseHtml(tree);
            treeBody.querySelectorAll('.item').forEach((item) => {
                if (pppoeDevId) return;
                const titleEl = item.querySelector(':scope > .title');
                if (!titleEl) return;
                const title = titleEl.textContent.replace(/\s+/g, ' ').trim();
                if (!PPPOE_FOLDER.test(title)) return;
                // ERP пишет onclick как $$.ui.tree.single.select(this.parentElement, '7', event)
                const sel = titleEl.querySelector('[onclick*="select"]');
                const m = sel && (sel.getAttribute('onclick') || '')
                    .match(/select\(\s*this\.parentElement\s*,\s*'(\d+)'/);
                if (m) pppoeDevId = m[1];
            });
        } catch (e) { /* ниже подставим IPoE-устройство */ }

        const deviceId = svcType === 'ipoe'
            ? ((ipoeDev && ipoeDev.id) || '')
            : (pppoeDevId || (ipoeDev && ipoeDev.id) || '');

        // Оба устройства держим в состоянии: при переключении типа
        // форма должна подставить своё, иначе PPPoE уйдёт на BRAS-004
        // и биллинг ответит «Подходящий ip ресурс не найден».
        const state = {
            current, free: ips, personType, devices, deviceId, svcType, creds,
            // Свободные серые адреса — для возврата на серый IP конкретным адресом
            greyFree: greyIps,
            // Выбор оператора в «Типе» переживает перерисовку: без этого
            // селект каждый раз прыгал на «Тестовый».
            kind: panel._tpWhiteIpKind || 'test',
            ipoeDeviceId: (ipoeDev && ipoeDev.id) || '',
            pppoeDeviceId: pppoeDevId || '',
            // Для индикаторов в блоке: белый или серый адрес и есть ли услуга
            ipKind,
            currentIp,
            activeType: activeSvc ? String(activeSvc.type || '') : '',
            // MAC и устройство действующего сервиса — для возврата на серый IP
            activeInet: activeInet || null,
            npay: npaySvc,
        };
        panel._tpWhiteIp = state;

        fillLazy(panel, 'whiteIp', renderWhiteIp(state));

        const badge = panel.querySelector('[data-role="whiteip-current"]');
        if (badge) {
            badge.textContent = current.length ? current[0].ip : '';
            badge.hidden = !current.length;
        }

        mountWhiteIp(panel);
        return state;
    }

    /**
     * Пометка вкладок ERP как устаревших + перезагрузка открытой «Интернета».
     *
     * Зачем: после выдачи или снятия белого IP меняется дерево сервисов,
     * а его показывает вкладка «Интернет» (она вложена в «Карточки»).
     * Без этого оператор видел противоречие: в «Для ТП» белый IP, а в
     * «Интернете» — прежний сервис с серым адресом.
     *
     * Почему не перезагружаем всё сразу, как кнопка-«вертушка» ERP:
     * у виджета tabs ОДИН слот this.xhr, и load() в начале делает
     * this.xhr.abort(). Цикл по вкладкам обрывал все запросы, кроме
     * последнего: панели оставались пустыми, а вложенные в «Карточки»
     * вкладки (в том числе «Интернет») исчезали вместе с их разметкой.
     *
     * Поэтому:
     *  • загруженным вкладкам сбрасываем флаг loaded — jQuery UI сам
     *    перезапросит их при следующем показе (проверено: beforeLoad
     *    читает именно data('loaded') у <li>);
     *  • «Интернет» перезагружаем сразу, но только если она открыта —
     *    оператор как раз смотрит на неё после смены адреса. Один вызов
     *    load(), без наложения запросов.
     */
    function refreshErpTabs(panel) {
        if (!panel || !window.jQuery) return;
        const $ = window.jQuery;
        const $root = $(panel).closest('.ui-tabs');
        if (!$root.length) return;

        // Все вкладки ERP в этой карточке, включая вложенные («Интернет»
        // живёт внутри «Карточек»), поэтому ищем по всему документу карточки.
        const host = $(panel).closest('#content > div[id^="contract_bill-"]');
        const $scope = host.length ? host : $root;
        const targets = [];

        $scope.find('.ui-tabs-nav > li').each(function () {
            const $li = $(this);
            const a = $li.find('> a').get(0);
            const href = a ? (a.getAttribute('href') || '') : '';
            // Наша панель (#…) и незагруженные вкладки — не трогаем:
            // незагруженная и так запросит сервер при первом открытии.
            if (!href || href.charAt(0) === '#') return;
            if (!$li.data('loaded')) return;
            targets.push({ $li, href });
        });

        targets.forEach(({ $li }) => {
            try { $li.data('loaded', false); } catch (e) { /* вкладка без AJAX */ }
        });

        // «Интернет» открыта — перезагружаем её саму, иначе оператор увидит
        // старый сервис до переключения вкладок.
        const inet = targets.find((t) => /inet\.do/i.test(t.href) && /moduleId=1/i.test(t.href));
        if (!inet) return;
        const $li = inet.$li;
        if (!$li.hasClass('ui-tabs-active') && !$li.hasClass('ui-state-active')) return;

        const $widget = $li.closest('.ui-tabs');
        const instance = $widget.data('ui-tabs') || $widget.data('tabs');
        if (!instance || typeof instance.load !== 'function') return;

        const index = $widget.find('> .ui-tabs-nav > li').index($li);
        if (index < 0) return;
        try { instance.load(index); } catch (e) { /* виджет без AJAX-загрузки */ }
    }

    /**
     * Полное обновление после выдачи или снятия белого IP.
     *
     * Раньше здесь стоял один setTimeout на 1.5 секунды и applyContent().
     * Этого мало по двум причинам:
     *
     *  1) биллинг применяет сервис не мгновенно — если ответить быстрее,
     *     дерево сервисов ещё отдаёт прежнее состояние, и панель показывала
     *     старый адрес, хотя операция уже прошла;
     *  2) обновлялась только наша панель. Вкладка «Интернет» оставалась
     *     с прежним сервисом, и оператор видел противоречие: в «Для ТП»
     *     белый IP, в «Интернете» — старый.
     *
     * Поэтому: сбрасываем кэш, ждём, пока в дереве сервисов появится
     * ожидаемое состояние, и только потом перерисовываем панель и
     * помечаем вкладки ERP устаревшими.
     *
     * expect: 'white' — ждём активный сервис с публичным адресом;
     *         'grey'  — ждём, что публичного адреса не осталось.
     *         null    — просто дождаться смены состояния, без условия.
     */
    async function refreshAfterIpChange(panel, expect) {
        if (!panel || !document.contains(panel)) return;

        const cid = panel.dataset.contractId;
        if (!cid) return;

        const generation = genOf(panel);
        // Сбрасываем весь кэш: менялись и дерево сервисов, и свободные адреса,
        // и абонплата (услуга «Публичный IP»), и карточки договора.
        netDrop();
        // Однократные кэши панели живут до перерисовки, но перерисовка будет
        // только после ожидания — сбрасываем сразу, чтобы проверка ниже
        // читала свежие данные, а не запомненные до операции.
        panel._tpOnce = null;
        panel._tpPwdCache = null;

        // Ждём применения в биллинге. Условие читает то же дерево сервисов,
        // что и блок «Белый IP», поэтому «данные пришли» означает именно то,
        // что увидит оператор.
        await waitUntil(async () => {
            const svc = await ERP.services(cid).catch(() => ({ list: [] }));
            const active = (svc.list || []).filter((s) =>
                /IPoE|PPPoE/i.test(s.type || '') && isAliveService(s));

            if (expect === 'white') {
                // Публичный адрес может быть и в имени сервиса, и в его карточке
                const byName = active.some((s) => isPublicIp(
                    (String(s.name || '').match(/(\d{1,3}(?:\.\d{1,3}){3})/) || [])[1]));
                if (byName) return true;
                const inet = await ERP.activeInetService(cid).catch(() => null);
                return !!(inet && isPublicIp(inet.addr));
            }

            if (expect === 'grey') {
                // Публичного адреса быть не должно ни в имени, ни в карточке
                const byName = active.some((s) => isPublicIp(
                    (String(s.name || '').match(/(\d{1,3}(?:\.\d{1,3}){3})/) || [])[1]));
                if (byName) return false;
                const inet = await ERP.activeInetService(cid).catch(() => null);
                return !(inet && isPublicIp(inet.addr));
            }

            return true;
        });

        // Панель перерисовали, пока ждали (кнопка «Обновить», возврат на
        // вкладку) — новая отрисовка сама прочитает свежие данные, и трогать
        // её нельзя: перетрём сообщение оператору и затрём его форму.
        if (genOf(panel) !== generation || !document.contains(panel)) return;

        // Кэш сбрасываем ещё раз: за время ожидания автообновление успело
        // набрать ответов, а часть из них могла прийти до применения сервиса.
        netDrop();
        await applyContent(panel, contentBuilder);

        // Вкладки ERP помечаем устаревшими после перерисовки: иначе их
        // загрузка начнётся раньше, чем биллинг отдаст новое состояние.
        refreshErpTabs(panel);
    }

    /**
     * Обработчик единственной кнопки блока «Белый IP».
     *
     * Раньше здесь было четыре независимых обработчика: «Навесить белый IP»,
     * «Подключить услугу», «Навесить серый IP» и «Убрать белый IP». Две
     * последние делали одно и то же — закрывали белый сервис и создавали
     * серый, отличаясь только позицией в абонплате, — и оператор выбирал
     * между ними наугад. Теперь действие выбирается в селекте «Тип»,
     * кнопка одна, а она разводит поток по веткам.
     */
    function mountWhiteIp(panel) {
        const btn = panel.querySelector('.tp-whiteip-apply');
        if (!btn || btn.dataset.bound === '1') return;
        btn.dataset.bound = '1';

        const msg = panel.querySelector('.tp-whiteip-msg');
        const say = (cls, text) => {
            if (!msg) return;
            msg.className = 'tp-msg tp-whiteip-msg ' + cls;
            msg.textContent = text;
        };

        const kindEl = panel.querySelector('.tp-whiteip-kind');
        const svcSel = panel.querySelector('.tp-whiteip-svc');
        const addrInput = panel.querySelector('.tp-whiteip-addr');

        /**
         * Пересчёт подписи и доступности кнопки под выбранный тип.
         *
         * Пул белых и пул серых — разные ресурсы: «Применить» должно гаснуть,
         * когда в нужном пуле нет свободного адреса. Иначе оператор нажимает
         * и получает отказ биллинга вместо понятного «адресов нет».
         */
        const refreshButton = () => {
            const st = panel._tpWhiteIp || {};
            const kind = kindEl ? kindEl.value : 'test';
            const isGrey = kind === 'grey';
            // Выбор запоминаем на панели: без этого после перерисовки селект
            // сбрасывался на «Тестовый», и оператор терял свой выбор.
            panel._tpWhiteIpKind = kind;
            btn.textContent = isGrey ? 'Навесить серый IP' : 'Навесить белый IP';

            if (isGrey) {
                btn.disabled = !((st.greyFree && st.greyFree[0]) || '');
                return;
            }
            const white = (st.free && st.free[0]) || '';
            if (addrInput) addrInput.value = white;
            btn.disabled = !white;
        };

        if (kindEl) {
            kindEl.addEventListener('change', () => {
                refreshButton();
                if (msg) { msg.className = 'tp-msg tp-whiteip-msg'; msg.textContent = ''; }
            });
        }

        // Переключение PPPoE/IPoE: у типов разные категории IP-ресурсов
        // («PPPoE белые» и «IPoE белые»), поэтому список адресов перезагружаем.
        if (svcSel) {
            svcSel.addEventListener('change', async () => {
                const isIpoe = svcSel.value === 'ipoe';
                const wrap = panel.querySelector('.tp-whiteip-dev-wrap');
                if (wrap) wrap.hidden = !isIpoe;
                // MAC нужен только для IPoE — там авторизация по MAC
                const macWrap = panel.querySelector('.tp-whiteip-mac-wrap');
                if (macWrap) macWrap.hidden = !isIpoe;
                // Логин и пароль показываем только для PPPoE
                const credsWrap = panel.querySelector('.tp-whiteip-creds');
                if (credsWrap) credsWrap.hidden = isIpoe;

                // Устройство своё у каждого типа: IPoE > BRAS-004,
                // PPPoE > папка PPPoE. Иначе биллинг не найдёт IP-ресурс.
                const st = panel._tpWhiteIp || {};
                const devInput = panel.querySelector('.tp-whiteip-device');
                const devName = panel.querySelector('.tp-whiteip-dev-name');
                const devId = isIpoe ? (st.ipoeDeviceId || '') : (st.pppoeDeviceId || '');
                if (devInput && devId) devInput.value = devId;
                if (devName) {
                    const list = st.devices || [];
                    const found = list.find((d) => String(d.id) === String(devId));
                    devName.textContent = found ? found.title
                        : (isIpoe ? 'BRAS Microtik: BRAS-004 [100.64.5.24]' : 'Папка: PPPoE');
                }

                const cid = panel.dataset.contractId;
                const cats = await ERP.freeIpList(cid, isIpoe ? 2 : 1).catch(() => []);
                // Обновляем оба пула: у нового типа подключения свои адреса,
                // и кнопка должна считать доступность по ним, а не по прежним.
                const fresh = panel._tpWhiteIp || (panel._tpWhiteIp = {});
                fresh.free = (cats || []).filter((c) => c.isWhite).flatMap((c) => c.ips);
                fresh.greyFree = (cats || [])
                    .filter((c) => !c.isWhite)
                    .flatMap((c) => c.ips)
                    .filter((ip) => !isPublicIp(ip));

                refreshButton();
                if (msg) { msg.className = 'tp-msg tp-whiteip-msg'; msg.textContent = ''; }
            });
        }

        /**
         * Единое действие блока. Что именно произойдёт, решает селект «Тип»:
         *
         *   Тестовый   — публичный адрес без позиции в абонплате (выдача на пробу);
         *   С услугой  — публичный адрес + «Публичный IP» в абонплате;
         *   Серый      — возврат на серый адрес, услуга снимается.
         *
         * Особый случай: белый адрес уже навешен, услуги нет, выбран
         * «С услугой». Тогда сервис НЕ пересоздаётся — адрес уже работает,
         * рвать сессию абонента незачем. Достаточно добавить позицию в
         * абонплату. Раньше для этого была отдельная кнопка «Подключить услугу».
         */
        btn.addEventListener('click', async () => {
            const state = panel._tpWhiteIp || {};
            const cid = panel.dataset.contractId;
            const devEl = panel.querySelector('.tp-whiteip-device');
            const kind = kindEl ? kindEl.value : 'test';
            const isGrey = kind === 'grey';
            const isLegal = state.personType === 'legal';
            const label = 'Публичный IP' + (isLegal ? ' (юрлица)' : '');

            const svcType = svcSel ? svcSel.value : (state.svcType || 'pppoe');
            const isIpoe = svcType === 'ipoe';
            // Устройство своё у каждого типа: IPoE > BRAS-004 (MAC-авторизация),
            // PPPoE > папка PPPoE (иначе не найдётся IP-ресурс из «PPPoE белые»).
            const deviceId = isIpoe
                ? (devEl ? devEl.value : (state.ipoeDeviceId || ''))
                : (state.pppoeDeviceId || (devEl ? devEl.value : ''));

            // ---- услуга без пересоздания сервиса
            //
            // Белый адрес уже навешен, услуги нет, выбрано «С услугой»:
            // добавляем только позицию в абонплате. Это самый частый путь —
            // адрес выдали тестом, абонент согласился платить.
            if (kind === 'regular' && state.ipKind === 'white' && !state.npay) {
                btn.disabled = true;
                say('', 'Подключаю услугу…');
                try {
                    const added = await addPublicIpService(cid, isLegal);
                    if (!added.ok) {
                        say('is-bad', 'Услугу «' + label + '» подключить не удалось: '
                            + (added.message || 'причина неизвестна'));
                        btn.disabled = false;
                        return;
                    }
                    say('is-ok', 'Услуга «' + label + '» ' + (added.message || 'подключена')
                        + ' — обновляю список');
                    refreshAfterIpChange(panel, null).catch(() => {});
                } catch (e) {
                    say('is-bad', 'Ошибка: ' + (e.message || e));
                    btn.disabled = false;
                }
                return;
            }

            if (!deviceId) {
                say('is-bad', isIpoe ? 'Не найдено устройство BRAS-004' : 'Не найдена папка PPPoE');
                return;
            }

            // MAC: сначала из поля (оператор мог поправить), иначе из
            // действующего сервиса — при смене адреса MAC должен остаться тем же.
            const macEl = panel.querySelector('.tp-whiteip-mac');
            const macRaw = isIpoe ? ((macEl && macEl.value) || '').trim() : '';
            const macFromField = normalizeMac(macRaw);
            const macFromService = normalizeMac((state.activeInet && state.activeInet.mac) || '');
            const mac = macFromField || macFromService;
            if (isIpoe && !macRaw && !mac) { say('is-bad', 'Укажите MAC роутера'); return; }
            if (isIpoe && !mac) {
                say('is-bad', 'MAC должен содержать 12 hex-символов, например a4ba.7002.8a61');
                return;
            }

            btn.disabled = true;
            say('', isGrey ? 'Навешиваю серый IP…' : 'Выполняется…');

            try {
                // ---- адрес берём заново, прямо перед созданием
                //
                // Список в форме мог устареть, пока оператор заполнял поля,
                // а биллинг на занятый адрес отвечает невнятным «Подходящий
                // ip ресурс не найден». Это же снимает нужду показывать адрес
                // в форме — он всегда актуальный первый свободный.
                const cats = await ERP.freeIpList(cid, isIpoe ? 2 : 1).catch(() => []);
                const pool = isGrey
                    ? (cats || []).filter((c) => !c.isWhite).flatMap((c) => c.ips)
                        .filter((ip) => !isPublicIp(ip))
                    : (cats || []).filter((c) => c.isWhite).flatMap((c) => c.ips);
                const addr = pool[0] || '';
                if (!addr) {
                    say('is-bad', isGrey
                        ? 'В сером пуле нет свободных адресов — освободите адрес в биллинге'
                        : 'В белом пуле нет свободных адресов');
                    btn.disabled = true;
                    return;
                }
                if (!isGrey && addrInput) addrInput.value = addr;

                // ---- закрываем активные сервисы вчерашним числом
                //
                // Логин занят ими же, поэтому без закрытия новый сервис с тем же
                // логином не создать. Сервисы с состоянием «удален» пропускаем:
                // в дереве они значатся открытыми, но в биллинге их уже нет,
                // и serviceUpdate по ним отвечает «Сервис не найден».
                const alive = (await ERP.services(cid)).list
                    .filter((s) => /^(PPPoE|IPoE)$/i.test(s.type || '') && isAliveService(s));
                const closeFailed = [];
                for (let i = 0; i < alive.length; i++) {
                    const sid = alive[i].id;
                    if (!sid) continue;
                    try {
                        const closed = await ERP.closeService(cid, sid, yesterdayRu());
                        // Биллинг может ответить 200 с ошибкой в теле — раньше
                        // это молча проглатывалось, и старый сервис оставался
                        // открытым, блокируя логин для нового.
                        if (!closed.ok || /BGException|Подходящий ip ресурс|не найден/i.test(String(closed.text || ''))) {
                            closeFailed.push(sid);
                        }
                    } catch (e) {
                        closeFailed.push(sid);
                    }
                }
                if (closeFailed.length && closeFailed.length === alive.filter((s) => s.id).length) {
                    say('is-bad', 'Не удалось закрыть текущий сервис — адрес не навешен. '
                        + 'Проверьте сервис в биллинге вручную.');
                    btn.disabled = false;
                    return;
                }

                // ---- новый сервис
                //
                // Пароль берём из поля, а не из состояния: оператор мог его
                // поправить. Пустое поле — тоже валидный выбор, тогда биллинг
                // сгенерирует пароль сам (generatePassword=1 в createService).
                const creds = state.creds || {};
                const pwdEl = panel.querySelector('.tp-whiteip-password');
                const password = pwdEl ? pwdEl.value.trim() : (creds.password || '');

                const res = await ERP.createService(cid, {
                    typeId: isIpoe ? 2 : 1,   // 1 = PPPoE, 2 = IPoE
                    login: creds.login || '',
                    password,
                    mac,
                    // Адрес передаём и для белого, и для серого: пустой addrFrom
                    // биллинг принимает, но адрес не выдаёт — сервис остаётся
                    // с 0.0.0.0 и заглушкой «[IpAddress:null]» в дереве.
                    addr,
                    deviceId,
                    comment: isGrey ? 'Серый IP'
                        : (kind === 'test' ? 'Тестовый белый IP'
                            : (isLegal ? 'Белый IP (юрлица)' : 'Белый IP')),
                });
                if (!res.ok) {
                    // Ошибку биллинга показываем человеческим языком: стектрейс
                    // с «at ru.bgcrm...» оператору ничего не даёт.
                    const raw = String(res.text || '');
                    const known = [
                        [/Подходящий ip ресурс не найден/i,
                            `Адрес ${addr} занят или не входит в пул для этого типа подключения — обновите блок`],
                        [/Логин .* уже используется/i,
                            'Логин занят активным сервисом — он не закрылся, повторите нажатие'],
                        [/Категория IP-ресурса не найдена/i,
                            'У устройства не настроена категория IP-ресурсов (IPoE требует BRAS-004)'],
                    ];
                    const hit = known.find(([re]) => re.test(raw));
                    say('is-bad', hit ? hit[1] : 'Биллинг отказал: ' + raw.slice(0, 120));
                    btn.disabled = false;
                    return;
                }

                // ---- позиция «Публичный IP» в абонплате
                //
                // Белый IP — это два действия в биллинге: сервис Inet с адресом
                // и позиция в «Абонентской плате» (npay). Без второй адрес
                // работает, но не тарифицируется. При снятии белого услугу
                // всегда убираем: если абонент отказался от адреса, он не должен
                // за него платить.
                let note = '';
                if (isGrey || kind === 'test') {
                    const removed = await removePublicIpService(cid, isLegal);
                    if (!removed.ok) {
                        note = ' · услугу «' + label + '» отключить не удалось: '
                            + (removed.message || 'причина неизвестна');
                    } else if (state.npay) {
                        note = ' · услуга «' + label + '» отключена';
                    }
                } else {
                    const added = await addPublicIpService(cid, isLegal);
                    note = added.ok
                        ? ' · услуга «' + label + '» ' + (added.message || 'подключена')
                        : ' · услугу «' + label + '» подключить не удалось: '
                            + (added.message || 'причина неизвестна');
                }

                say('is-ok', 'Готово: ' + (isGrey ? 'серый IP ' + addr : 'белый IP ' + addr)
                    + note + ' — обновляю список');
                // Пароль мог быть изменён в поле, а блок «Доступы» берёт его
                // из кэша — без сброса он показывал бы старое значение.
                if (panel._tpPwdCache) panel._tpPwdCache.delete(cid);
                // Ждём, пока биллинг применит сервис, и обновляем всё: панель,
                // вкладки ERP («Интернет» показывает то же дерево сервисов).
                refreshAfterIpChange(panel, isGrey ? 'grey' : 'white').catch(() => {});
            } catch (e) {
                say('is-bad', 'Ошибка: ' + (e.message || e));
                btn.disabled = false;
            }
        });
    }


    /* ------------------------------------------------------------- процессы */

    /**
     * Блок «Процессы»: обращения договора, активные и закрытые.
     *
     * Вкладки — это родные фильтры ERP (open=1 / open=0), а не разбор статуса
     * по тексту: в биллинге статусов десятки («Новый», «В работе», «Согласовано»,
     * «Завершено», «Отклонено»…), и любой самодельный список рано или поздно
     * разошёлся бы с тем, что видит оператор на вкладке «Процессы».
     *
     * Счётчики на вкладках показываем из ответа ERP («Записей: N»), а не по
     * числу отрисованных строк: список режется по pageSize, и цифра должна
     * отражать реальное количество.
     */
    function renderProcesses(data, kind) {
        const d = data || {};
        const isOpen = kind === 'open';
        // Списки лежат в разных полях состояния, а дальше код работает с одним
        // набором строк. Раньше здесь читалось d.rows напрямую, но в состоянии
        // его нет — и блок показывал «Активных процессов нет» при 20 записях
        // в ответе ERP.
        const rows = (isOpen ? d.open : d.closed) || [];

        const tabs = `<div class="tp-tabs-mini tp-proc-tabs">
            <button type="button" class="${isOpen ? 'is-on' : ''}" data-kind="open">
                Активные <span class="tp-count ${d.openTotal ? 'is-on' : ''}" data-role="proc-open-count">${d.openTotal || 0}</span>
            </button>
            <button type="button" class="${isOpen ? '' : 'is-on'}" data-kind="closed">
                Закрытые <span class="tp-count ${d.closedTotal ? 'is-on' : ''}" data-role="proc-closed-count">${d.closedTotal || 0}</span>
            </button>
        </div>`;

        if (!rows.length) {
            return tabs + `<div class="tp-sess-empty">${isOpen
                ? 'Активных процессов нет.'
                : 'Закрытых процессов нет.'}</div>`;
        }

        let html = '<div class="tp-proc-list">';
        rows.forEach((p) => {
            // Статус — плашкой: «Новый» и «В работе» оператор различает сразу
            const isDone = /заверш|закрыт|отклон|отмен/i.test(p.status || '');
            const chip = isDone ? 'is-good' : 'is-warn';
            const num = p.id ? `#${esc(p.id)}` : '';
            const title = p.name || p.type || 'Процесс';

            // Строка ведёт в карточку процесса — тот же переход, что делает сам
            // ERP из очереди процессов. Без id строку не делаем ссылкой: лучше
            // некликабельный текст, чем переход в никуда.
            //
            // role/tabindex — чтобы строку можно было открыть с клавиатуры:
            // это div с обработчиком клика, сам по себе он фокус не получает.
            const linkable = !!p.id;
            html += `<div class="tp-proc-row${linkable ? ' is-link' : ''}"`
                + `${linkable ? ` data-proc="${esc(p.id)}" role="link" tabindex="0"` : ''}>
                <div class="tp-proc-main">
                    <div class="tp-proc-name">${num ? `<span class="tp-proc-num">${num}</span> ` : ''}${esc(title)}</div>
                    <div class="tp-proc-meta">${esc(p.type || '')}${p.created ? ' · создан ' + esc(p.created) : ''}</div>
                </div>
                <span class="tp-chip is-xs ${chip}">${esc(p.status || '—')}</span>
            </div>`;
        });
        html += '</div>';

        if (d.total > rows.length) {
            html += `<div class="tp-hint">Показаны ${rows.length} из ${esc(d.total)}.</div>`;
        }

        return tabs + html;
    }

    /** Загрузка обеих вкладок процессов: счётчики нужны сразу, не после клика. */
    async function loadProcesses(panel, cid) {
        const generation = genOf(panel);
        const id = cid || panel.dataset.contractId;
        if (!id) return null;

        // Оба списка параллельно: иначе цифра на второй вкладке появится только
        // после переключения, и оператор не поймёт, есть ли там что-то.
        const [open, closed] = await Promise.all([
            ERP.processes(id, 1).catch(() => ({ rows: [], total: 0 })),
            ERP.processes(id, 0).catch(() => ({ rows: [], total: 0 })),
        ]);

        if (genOf(panel) !== generation) return null;
        if (!document.contains(panel)) return null;

        const state = {
            open: open.rows,
            closed: closed.rows,
            openTotal: open.total,
            closedTotal: closed.total,
            kind: panel._tpProcKind || 'open',
        };
        panel._tpProcesses = state;

        fillLazy(panel, 'processes', renderProcesses(state, state.kind));

        const badge = panel.querySelector('[data-role="proc-state"]');
        if (badge) {
            badge.textContent = state.openTotal ? String(state.openTotal) : '';
            badge.hidden = !state.openTotal;
        }

        mountProcesses(panel);
        return state;
    }

    /**
     * Переключение «Активные / Закрытые» и переход в карточку процесса.
     *
     * Переход делаем через штатный API оболочки — им же пользуется сам ERP в
     * списке процессов: `$$.process.open(id)` разворачивается в
     * `$$.shell.contentLoad("process#" + id)`. Так открывается карточка, и URL
     * меняется на `/user/process#N`, поэтому кнопка «Назад» возвращает к
     * договору — проверено на живой странице.
     *
     * Если API недоступен (ядро ERP ещё не инициализировалось или версия другая),
     * переходим по адресу напрямую: ERP разбирает hash при загрузке и открывает
     * тот же процесс. Без этого запасного пути клик просто ничего не делал бы.
     */
    function mountProcesses(panel) {
        const card = panel.querySelector('.tp-processes');
        if (!card) return;
        if (card.dataset.bound === '1') return;
        card.dataset.bound = '1';

        const openProcess = (pid) => {
            if (!pid) return;
            // $$ объявлен как const и не является свойством window.
            // Обращаемся к глобальной переменной напрямую, с проверкой typeof.
            let api = null;
            try {
                if (typeof $$ !== 'undefined' && $$ && $$.process) api = $$.process;
            } catch (e) { /* ядро ещё не загрузилось */ }
            if (!api && window.$$ && window.$$.process) api = window.$$.process;

            if (api && typeof api.open === 'function') {
                try { api.open(pid); return; } catch (e) { /* упадём на адрес ниже */ }
            }
            window.location.href = '/user/process#' + encodeURIComponent(pid);
        };

        card.addEventListener('click', (ev) => {
            // Строка процесса: клик по любому месту строки ведёт в карточку
            const row = ev.target.closest('.tp-proc-row[data-proc]');
            if (row) {
                openProcess(row.dataset.proc);
                return;
            }

            const btn = ev.target.closest('.tp-proc-tabs button');
            if (!btn) return;
            const kind = btn.dataset.kind || 'open';
            const state = panel._tpProcesses || {};
            panel._tpProcKind = kind;

            // Списки уже загружены — перерисовываем без сети
            const body = card.querySelector('.tp-lazy-body');
            if (body) setHtmlIfChanged(body, renderProcesses(Object.assign({}, state, { kind }), kind));
        });

        // Строка — это div с role="link", сам по себе он Enter не обрабатывает.
        // Без этого клавиатура открыть процесс не могла бы, хотя мышью — можно.
        card.addEventListener('keydown', (ev) => {
            if (ev.key !== 'Enter' && ev.key !== ' ') return;
            const row = ev.target.closest('.tp-proc-row[data-proc]');
            if (!row) return;
            ev.preventDefault();
            openProcess(row.dataset.proc);
        });
    }

    /* ------------------------------------------------ отправка доступа на почту */

    /**
     * Сохранение/чтение настроек почты (отправитель и получатель).
     *
     * Оператор отправляет письма весь день, и каждый раз выбирать адрес заново —
     * лишние клики. Запоминаем последний выбор в localStorage: он общий для всех
     * договоров, потому что «с какой почты я пишу» — свойство оператора,
     * а не абонента.
     */
    const mailStore = {
        get(key, def) {
            try { return window.localStorage.getItem(key) || def; } catch (e) { return def; }
        },
        set(key, value) {
            try { window.localStorage.setItem(key, String(value)); } catch (e) { /* приватный режим */ }
        },
    };

    /** Адрес из карточки договора (поле E-mail), без угловых скобок. */
    function contractEmail(panel) {
        const el = panel && panel.querySelector('.tp-client-group');
        // Поле E-mail рисуется ссылкой mailto: в группе «Контакты»
        const link = panel && panel.querySelector('a[href^="mailto:"]');
        if (link) return String(link.getAttribute('href') || '').replace(/^mailto:/i, '').trim();
        // Запасной путь: значение из params() могло остаться текстом
        const m = el ? (el.innerText.match(/[\w.+-]+@[\w.-]+\.\w+/) || [])[0] : '';
        return m || '';
    }

    /** Данные для письма: логины и пароли, которые скрипт уже знает. */
    function mailPayload(panel) {
        const st = panel._tpWhiteIp || {};
        const creds = st.creds || {};
        const login = creds.login || '';
        const pwdPppoe = creds.password || '';
        // Пароль статистики ищем по ПРОИСХОЖДЕНИЮ строки, а не по позиции
        // в DOM. Раньше брался первый .tp-pwd-val в панели: при пустом пароле
        // статистики строки не было вовсе, и в письмо под подписью «личный
        // кабинет» уходил пароль PPPoE.
        const stat = panel.querySelector('.tp-pwd-row[data-kind="stat"] .tp-pwd-val[data-pwd]');
        const pwdStat = stat ? (stat.dataset.pwd || '') : '';
        return { login, pwdPppoe, pwdStat };
    }

    /**
     * Собирает письмо под выбранный набор доступов.
     *
     * Только сами доступы, без подписей и пояснений: абоненту нужно скопировать
     * логин и пароль, а «Договор: …» и фраза про сотрудника поддержки только
     * удлиняли письмо. Номер договора и так есть в теме письма.
     *
     * kind = 'custom' — произвольный текст оператора: в этом режиме тело письма
     * берётся из поля ввода как есть, ничего не подставляется.
     */
    function buildMailBody(kind, data, customText) {
        if (kind === 'custom') return String(customText == null ? '' : customText);

        const d = data || {};
        const login = d.login || '—';

        const pppoe = [
            'Доступ в интернет (PPPoE):',
            'Логин: ' + login,
            'Пароль: ' + (d.pwdPppoe || '—'),
        ];
        const cabinet = [
            'Доступ к личному кабинету:',
            'Логин: ' + login,
            'Пароль: ' + (d.pwdStat || '—'),
        ];

        if (kind === 'pppoe') return pppoe.join('\n');
        if (kind === 'stats') return cabinet.join('\n');
        // both — оба блока в одном письме, разделённые пустой строкой
        return pppoe.join('\n') + '\n\n' + cabinet.join('\n');
    }

    /** Тема письма — одна для всех наборов, чтобы абонент узнавал его в ящике. */
    function buildMailSubject(contractNo) {
        return 'Доступы к интернету — договор ' + (contractNo || '');
    }

    /**
     * Блок «Отправить на почту».
     *
     * Состав: получатель (подставляется из договора, можно поправить),
     * отправитель (адреса ERP), что отправляем (PPPoE / статистика / оба),
     * кнопка и результат. Текст письма оператор не правит: он всегда один
     * и тот же по смыслу, а лишнее поле только замедляет работу.
     */
    function renderMail(panel, state) {
        const s = state || {};
        const to = s.to || '';
        const sender = s.sender || MAIL_DEFAULT_SENDER;
        const kind = s.kind || 'pppoe';
        const customText = s.customText || '';
        const d = s.data || {};
        const noTo = !to;
        const isCustom = kind === 'custom';
        // Пароль нужен только для готовых наборов: в произвольном письме
        // оператор сам решает, что писать, и требовать пароль нельзя.
        const noPwd = !isCustom && ((kind === 'pppoe' || kind === 'both') ? !d.pwdPppoe : !d.pwdStat);
        const noBody = isCustom && !customText.trim();

        const senderOpts = MAIL_SENDERS.map((m) =>
            `<option value="${esc(m.id)}"${String(m.id) === String(sender) ? ' selected' : ''}>${esc(m.email)}</option>`
        ).join('');

        return `<div class="tp-mail-form">
            <label class="tp-field">
                <span>Получатель</span>
                <input type="text" class="tp-mail-to" value="${esc(to)}"
                       placeholder="почта абонента"${noTo ? ' data-empty="1"' : ''}>
            </label>
            <label class="tp-field">
                <span>Отправитель</span>
                <select class="tp-mail-from">${senderOpts}</select>
            </label>
            <label class="tp-field">
                <span>Что отправить</span>
                <select class="tp-mail-kind">
                    <option value="pppoe"${kind === 'pppoe' ? ' selected' : ''}>Логин и пароль PPPoE</option>
                    <option value="stats"${kind === 'stats' ? ' selected' : ''}>Логин и пароль личного кабинета</option>
                    <option value="both"${kind === 'both' ? ' selected' : ''}>Оба доступа</option>
                    <option value="custom"${isCustom ? ' selected' : ''}>Произвольный текст</option>
                </select>
            </label>
            <label class="tp-field tp-mail-custom-wrap"${isCustom ? '' : ' hidden'}>
                <span>Текст письма</span>
                <textarea class="tp-mail-custom" rows="5"
                          placeholder="Впишите, что нужно отправить абоненту">${esc(customText)}</textarea>
            </label>
            <div class="tp-mail-preview"${isCustom ? ' hidden' : ''}>
                <div class="tp-mail-preview-title">Письмо</div>
                <div class="tp-mail-preview-subject">${esc(buildMailSubject(s.contractNo))}</div>
                <pre class="tp-mail-preview-text">${esc(buildMailBody(kind, d, customText))}</pre>
            </div>
            <button type="button" class="tp-btn tp-mail-send"${(noTo || noPwd || noBody) ? ' disabled' : ''}>Отправить</button>
            ${noTo ? '<span class="tp-mail-hint is-bad">В договоре не заполнен E-mail — впишите адрес вручную.</span>' : ''}
            ${!noTo && noPwd ? '<span class="tp-mail-hint is-bad">Нет пароля для выбранного доступа — отправка невозможна.</span>' : ''}
            ${!noTo && noBody ? '<span class="tp-mail-hint is-bad">Впишите текст письма.</span>' : ''}
            <span class="tp-msg tp-mail-msg"></span>
        </div>`;
    }

    /** Загрузка данных для блока почты. */
    async function loadMail(panel, cid) {
        const generation = genOf(panel);
        const id = cid || panel.dataset.contractId;
        if (!id) return null;

        // Логин и пароли уже добыты блоком «Белый IP»; если он ещё не успел —
        // ждём его состояние, чтобы не дублировать запросы к contractCards.
        let st = panel._tpWhiteIp;
        if (!st) {
            st = await erpOnce(panel, 'whiteIpState', () => loadWhiteIp(panel, id)).catch(() => null);
        }

        if (genOf(panel) !== generation) return null;
        if (!document.contains(panel)) return null;

        const data = mailPayload(panel);
        const savedTo = mailStore.get(MAIL_STORE_TO, '');
        const contractTo = contractEmail(panel);
        const state = {
            // Получатель: приоритет у договора — он точнее запомненного вручную
            to: contractTo || savedTo || MAIL_FALLBACK_TO,
            sender: mailStore.get(MAIL_STORE_SENDER, MAIL_DEFAULT_SENDER),
            kind: panel._tpMailKind || 'pppoe',
            data,
            contractNo: (st && st.creds && st.creds.login) || ERP.contractNumber(id) || '',
        };
        panel._tpMail = state;

        fillLazy(panel, 'mail', renderMail(panel, state));
        mountMail(panel);
        return state;
    }

    /** Обработчики блока почты: смена полей и отправка. */
    function mountMail(panel) {
        const card = panel.querySelector('.tp-mail');
        if (!card) return;
        const btn = card.querySelector('.tp-mail-send');
        if (!btn || btn.dataset.bound === '1') return;
        btn.dataset.bound = '1';

        const msg = card.querySelector('.tp-mail-msg');
        const say = (cls, text) => {
            if (!msg) return;
            msg.className = 'tp-msg tp-mail-msg ' + cls;
            msg.textContent = text;
        };

        const toEl = card.querySelector('.tp-mail-to');
        const fromEl = card.querySelector('.tp-mail-from');
        const kindEl = card.querySelector('.tp-mail-kind');
        const preview = card.querySelector('.tp-mail-preview-text');
        const subjectEl = card.querySelector('.tp-mail-preview-subject');
        const previewBox = card.querySelector('.tp-mail-preview');
        const customWrap = card.querySelector('.tp-mail-custom-wrap');
        const customEl = card.querySelector('.tp-mail-custom');

        // Перерисовка формы при смене набора: у «Произвольного текста» вместо
        // предпросмотра показываем поле ввода, а пароль не требуется.
        const refreshPreview = () => {
            const state = panel._tpMail || {};
            const kind = kindEl ? kindEl.value : 'pppoe';
            const isCustom = kind === 'custom';
            const customText = customEl ? customEl.value : (state.customText || '');
            panel._tpMailKind = kind;
            panel._tpMail = Object.assign({}, state, { kind, customText });

            if (customWrap) customWrap.hidden = !isCustom;
            if (previewBox) previewBox.hidden = isCustom;
            if (preview) preview.textContent = buildMailBody(kind, state.data, customText);
            if (subjectEl) subjectEl.textContent = buildMailSubject(state.contractNo);

            // Кнопка активна, только если есть пароль (для готовых наборов)
            // и непустое тело письма (для произвольного текста)
            const d = state.data || {};
            const hasPwd = isCustom ? true
                : ((kind === 'pppoe' || kind === 'both') ? !!d.pwdPppoe : !!d.pwdStat);
            const hasBody = isCustom ? !!String(customText || '').trim() : true;
            if (btn) btn.disabled = !hasPwd || !hasBody || !(toEl && toEl.value.trim());
        };

        if (kindEl) {
            kindEl.addEventListener('change', () => {
                refreshPreview();
                // Поставили «Произвольный текст» — сразу в поле, чтобы печатать
                if (kindEl.value === 'custom' && customEl) customEl.focus();
            });
        }
        if (customEl) {
            customEl.addEventListener('input', refreshPreview);
        }
        if (toEl) {
            toEl.addEventListener('input', () => {
                panel._tpMail = Object.assign({}, panel._tpMail, { to: toEl.value.trim() });
                mailStore.set(MAIL_STORE_TO, toEl.value.trim());
                refreshPreview();
            });
        }
        if (fromEl) {
            fromEl.addEventListener('change', () => {
                panel._tpMail = Object.assign({}, panel._tpMail, { sender: fromEl.value });
                mailStore.set(MAIL_STORE_SENDER, fromEl.value);
            });
        }

        btn.addEventListener('click', async () => {
            const state = panel._tpMail || {};
            const cid = panel.dataset.contractId;
            const to = toEl ? toEl.value.trim() : state.to;
            const sender = fromEl ? fromEl.value : state.sender;
            const kind = kindEl ? kindEl.value : 'pppoe';
            const customText = customEl ? customEl.value : (state.customText || '');

            if (!to) { say('is-bad', 'Укажите почту получателя'); return; }
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
                say('is-bad', 'Похоже, адрес указан с ошибкой: ' + to);
                return;
            }
            if (kind === 'custom' && !String(customText).trim()) {
                say('is-bad', 'Впишите текст письма');
                return;
            }

            btn.disabled = true;
            say('', 'Отправляю…');

            let processId = '';
            try {
                // 1) Обращение «1 Линия» — без него сообщение в ERP не создать
                const created = await ERP.createProcess(cid, {
                    description: 'Выдача доступов на почту',
                });
                if (!created.ok) {
                    say('is-bad', 'Не удалось создать обращение: ' + (created.message || 'причина неизвестна'));
                    btn.disabled = false;
                    return;
                }
                processId = created.id;

                // 2) Само письмо — сообщение процесса нужного типа (адрес отправителя)
                const sent = await ERP.sendProcessMessage(processId, {
                    typeId: sender,
                    to,
                    subject: buildMailSubject(state.contractNo),
                    text: buildMailBody(kind, state.data, customText),
                });
                if (!sent.ok) {
                    say('is-bad', 'Письмо не отправлено: ' + (sent.message || 'причина неизвестна')
                        + ' · обращение #' + processId + ' оставлено открытым');
                    btn.disabled = false;
                    return;
                }

                // 3) Обращение закрываем: письмо ушло, держать его в очереди незачем
                const closed = await ERP.closeProcess(processId, 'Доступы отправлены на почту');
                const closeNote = closed.ok ? '' : ' · обращение #' + processId + ' закрыть не удалось';

                say('is-ok', 'Отправлено на ' + to + closeNote);
                btn.disabled = false;
            } catch (e) {
                say('is-bad', 'Ошибка: ' + (e.message || e)
                    + (processId ? ' · обращение #' + processId : ''));
                btn.disabled = false;
            }
        });
    }

    /* ---------------------------------------------------------- примечания */

    /**
     * Блок «Примечания»: список записей и форма создания/правки.
     *
     * Это тот же узел, что в дереве карточки BGBilling (method=memoList).
     * Раньше за примечаниями нужно было уходить во вкладку «Параметры»
     * и терять контекст разговора с абонентом.
     *
     * Форма одна на создание и правку: у биллинга это один метод updateMemo,
     * где пустой id означает «создать». Так оператор не учит два разных окна.
     */
    function renderMemoList(list) {
        const items = list || [];

        let html = `<div class="tp-memo-actions">
            <button type="button" class="tp-btn tp-memo-add">Добавить</button>
            <span class="tp-msg tp-memo-msg"></span>
        </div>`;

        // Форма скрыта до нажатия «Добавить» или «Редактировать»:
        // постоянное поле ввода занимало полблока ради редкого действия.
        html += `<div class="tp-memo-form" hidden>
            <label class="tp-field">
                <span>Тема</span>
                <input type="text" class="tp-memo-title" maxlength="250" placeholder="Коротко о чём">
            </label>
            <label class="tp-field tp-memo-text-wrap">
                <span>Текст</span>
                <textarea class="tp-memo-text" rows="5" placeholder="Подробности"></textarea>
            </label>
            <div class="tp-memo-form-btns">
                <button type="button" class="tp-btn tp-memo-save">Сохранить</button>
                <button type="button" class="tp-btn is-ghost tp-memo-cancel">Отмена</button>
                <span class="tp-msg tp-memo-form-msg"></span>
            </div>
        </div>`;

        if (!items.length) {
            html += '<div class="tp-hint">Примечаний нет.</div>';
            return html;
        }

        html += '<div class="tp-memo-list">';
        items.forEach((m) => {
            // Текст в <pre>: переносы строк в примечаниях значимые (адреса,
            // договорённости списком), а в обычном div они бы схлопнулись.
            html += `<div class="tp-memo-item" data-memo-id="${esc(m.id)}">
                <div class="tp-memo-head">
                    <span class="tp-memo-title-text">${esc(m.title || 'Без темы')}</span>
                    <span class="tp-memo-meta">${esc(m.date || '')}${m.user ? ' · ' + esc(m.user) : ''}</span>
                </div>
                ${m.text ? `<pre class="tp-memo-text-body">${esc(m.text)}</pre>` : ''}
                <div class="tp-memo-item-btns">
                    <button type="button" class="tp-btn is-ghost tp-memo-edit">Изменить</button>
                    <button type="button" class="tp-btn is-ghost tp-memo-del">Удалить</button>
                </div>
            </div>`;
        });
        html += '</div>';
        return html;
    }

    /**
     * Обработчики блока «Примечания».
     *
     * Состояние живёт на карточке (panel._tpMemos), а не в замыкании модуля:
     * у двух открытых договоров списки разные, и общая переменная подставила
     * бы примечания соседнего договора.
     */
    function mountMemo(panel) {
        const card = panel.querySelector('.tp-lazy[data-lazy="memo"]');
        if (!card) return;
        const body = card.querySelector('.tp-lazy-body');
        if (!body) return;

        const cid = () => panel.dataset.contractId
            || ERP.contractId(panel.closest('#content > div[id^="contract_bill-"]'));

        const form = body.querySelector('.tp-memo-form');
        const titleEl = body.querySelector('.tp-memo-title');
        const textEl = body.querySelector('.tp-memo-text');
        const msg = body.querySelector('.tp-memo-msg');
        const formMsg = body.querySelector('.tp-memo-form-msg');

        // ID правимой записи: '' — создание новой
        let editingId = '';

        const say = (el, cls, text) => {
            if (!el) return;
            el.className = el.className.replace(/\s*is-(ok|bad)/g, '') + ' ' + cls;
            el.textContent = text;
        };

        const showForm = (memo) => {
            editingId = (memo && memo.id) || '';
            if (titleEl) titleEl.value = (memo && memo.title) || '';
            if (textEl) textEl.value = (memo && memo.text) || '';
            if (form) form.hidden = false;
            say(formMsg, '', '');
            if (titleEl) titleEl.focus();
        };

        const hideForm = () => {
            editingId = '';
            if (form) form.hidden = true;
            if (titleEl) titleEl.value = '';
            if (textEl) textEl.value = '';
            say(formMsg, '', '');
        };

        /** Перезагрузка списка после изменения — без полной перерисовки панели. */
        const reload = async () => {
            const id = cid();
            if (!id) return;
            const list = await ERP.memos(id).catch((e) => {
                say(msg, 'is-bad', e.message || 'Не удалось загрузить примечания');
                return null;
            });
            if (!list) return;
            panel._tpMemos = list;
            body.innerHTML = renderMemoList(list);
            const count = panel.querySelector('[data-role="memo-count"]');
            if (count) count.textContent = list.length ? String(list.length) : '';
            mountMemo(panel);
        };

        // ---- добавить
        const addBtn = body.querySelector('.tp-memo-add');
        if (addBtn) addBtn.addEventListener('click', () => showForm(null));

        // ---- отмена
        const cancelBtn = body.querySelector('.tp-memo-cancel');
        if (cancelBtn) cancelBtn.addEventListener('click', hideForm);

        // ---- сохранить
        const saveBtn = body.querySelector('.tp-memo-save');
        if (saveBtn) {
            saveBtn.addEventListener('click', async () => {
                const id = cid();
                if (!id) { say(formMsg, 'is-bad', 'Нет ID договора'); return; }
                const title = (titleEl && titleEl.value || '').trim();
                const text = (textEl && textEl.value || '').trim();
                if (!title && !text) {
                    say(formMsg, 'is-bad', 'Заполните тему или текст');
                    return;
                }
                saveBtn.disabled = true;
                say(formMsg, '', 'Сохранение…');
                try {
                    const res = await ERP.memoSave(id, { id: editingId, title, text });
                    if (!res.ok) {
                        say(formMsg, 'is-bad', res.message || 'Биллинг отклонил запрос');
                        return;
                    }
                    await reload();
                    const freshMsg = panel.querySelector('.tp-memo-msg');
                    say(freshMsg, 'is-ok', editingId ? 'Примечание изменено' : 'Примечание добавлено');
                } catch (e) {
                    say(formMsg, 'is-bad', e.message || 'Ошибка сохранения');
                } finally {
                    saveBtn.disabled = false;
                }
            });
        }

        // ---- изменить / удалить по каждой записи
        body.querySelectorAll('.tp-memo-item').forEach((item) => {
            const memoId = item.dataset.memoId;
            const memo = (panel._tpMemos || []).find((m) => String(m.id) === String(memoId));

            const editBtn = item.querySelector('.tp-memo-edit');
            if (editBtn) editBtn.addEventListener('click', () => showForm(memo || { id: memoId }));

            const delBtn = item.querySelector('.tp-memo-del');
            if (delBtn) {
                delBtn.addEventListener('click', async () => {
                    const id = cid();
                    if (!id) return;
                    // Подтверждение не спрашиваем: окно рвало разговор с абонентом,
                    // а промах лечится кнопкой «Вернуть» в сообщении под списком.
                    delBtn.disabled = true;
                    try {
                        const res = await ERP.memoDelete(id, memoId);
                        if (!res.ok) {
                            say(msg, 'is-bad', res.message || 'Биллинг отклонил удаление');
                            delBtn.disabled = false;
                            return;
                        }
                        await reload();
                        offerUndo(panel, memo, 'Примечание удалено');
                    } catch (e) {
                        say(msg, 'is-bad', e.message || 'Ошибка удаления');
                        delBtn.disabled = false;
                    }
                });
            }
        });
    }

    /**
     * Сообщение об удалении с кнопкой «Вернуть».
     *
     * Подтверждение перед удалением убрано — окно браузера рвало разговор
     * с абонентом. Взамен после факта появляется отмена: удаление в биллинге
     * необратимо, но запись можно создать заново с той же темой и текстом.
     * ID будет новый, дата и автор — текущие; это честно и оператору понятно.
     */
    function offerUndo(panel, memo, okText) {
        const msg = panel.querySelector('.tp-memo-msg');
        if (!msg || !memo) return;

        msg.className = 'tp-msg tp-memo-msg is-ok';
        msg.textContent = okText + ' ';

        const undo = document.createElement('button');
        undo.type = 'button';
        undo.className = 'tp-memo-undo';
        undo.textContent = 'Вернуть';
        msg.appendChild(undo);

        // Таймер не нужен: оператор либо вернёт сразу, либо уйдёт дальше.
        // Повторное удаление сбрасывает старое сообщение через reload().
        undo.addEventListener('click', async () => {
            const id = panel.dataset.contractId
                || ERP.contractId(panel.closest('#content > div[id^="contract_bill-"]'));
            if (!id) return;
            undo.disabled = true;
            undo.textContent = 'Возвращаю…';
            try {
                const res = await ERP.memoSave(id, { id: '', title: memo.title || '', text: memo.text || '' });
                if (!res.ok) {
                    msg.className = 'tp-msg tp-memo-msg is-bad';
                    msg.textContent = res.message || 'Не удалось вернуть примечание';
                    return;
                }
                // Перерисовываем список тем же путём, что и после сохранения
                const list = await ERP.memos(id).catch(() => null);
                if (list) {
                    panel._tpMemos = list;
                    const body = panel.querySelector('.tp-lazy[data-lazy="memo"] .tp-lazy-body');
                    if (body) {
                        body.innerHTML = renderMemoList(list);
                        const count = panel.querySelector('[data-role="memo-count"]');
                        if (count) count.textContent = list.length ? String(list.length) : '';
                        mountMemo(panel);
                        const fresh = panel.querySelector('.tp-memo-msg');
                        if (fresh) {
                            fresh.className = 'tp-msg tp-memo-msg is-ok';
                            fresh.textContent = 'Примечание восстановлено';
                        }
                    }
                }
            } catch (e) {
                msg.className = 'tp-msg tp-memo-msg is-bad';
                msg.textContent = e.message || 'Не удалось вернуть примечание';
            }
        });
    }

    /**
     * Есть ли в абонплате договора услуга «Публичный IP-адрес».
     *
     * Модуль «Абонентская плата» в BGBilling — это npay (moduleId=2).
     * Услуга «Публичный IP-адрес» имеет serviceId=72, для юрлица — 73.
     */
    async function findPublicIpNpayService(cid, isLegal) {
        const id = cid || '';
        const want = isLegal ? '73' : '72';
        if (!id) return null;
        try {
            const html = await fetchText(
                `/user/plugin/bgbilling/proto/npay.do?billingId=bill&contractId=${encodeURIComponent(id)}`
                + '&method=serviceList&moduleId=2'
            );
            const body = parseHtml(html);
            const rows = Array.from(body.querySelectorAll('table.data tr'));
            let found = null;
            rows.forEach((tr) => {
                const tds = Array.from(tr.querySelectorAll('td'));
                if (tds.length < 4) return;
                const name = (tds[1].textContent || '').replace(/\s+/g, ' ').trim();
                if (!/Публичный\s+IP/i.test(name)) return;
                // юрлицо — только строка «(юрлица)», физлицо — без пометки
                if (/юрлиц/i.test(name) !== !!isLegal) return;
                // период: «26.10.2026 - » — открыт; с датой окончания — закрыт
                const period = (tds[3].textContent || '').replace(/\s+/g, ' ').trim();
                if (/-\s*\d{2}\.\d{2}\.\d{4}/.test(period)) return;
                // id услуги берём из onclick редактирования.
                // В ERP ссылка выглядит как npay.do?id=70919&method=serviceGet,
                // поэтому сначала ищем ?id=, а как запасной путь — голый id=.
                const link = tr.querySelector('[onclick*="npay.do"]');
                const onclick = link ? (link.getAttribute('onclick') || '') : '';
                const m = onclick.match(/npay\.do\?id=(\d+)/) || onclick.match(/[?&]id=(\d+)/);
                if (m) found = { id: m[1], name, period, serviceId: want };
            });
            return found;
        } catch (e) {
            return null;
        }
    }

    /**
     * Подключение услуги «Публичный IP-адрес» в абонплату.
     *
     * ERP делает это формой /user/plugin/dogovor/npay.do (проверено на живой
     * карточке 36160: форма «Редактор» постит именно туда):
     *   method=update, contractId, billingId=bill, moduleId=2,
     *   id=<пусто для новой>, serviceId=72 (физлицо) / 73 (юрлицо),
     *   count=1, dateFrom, dateTo=<пусто — бессрочно>, objectId=0, comment.
     *
     * Раньше запрос уходил на /proto/npay.do с method=serviceUpdate. Этого
     * метода у плагина нет, и он молча отвечал {"status":"ok"} — услуга
     * «подключалась» только в отчёте оператору. Проверка: тот же запрос с
     * несуществующим serviceId=0 тоже возвращает ok, а настоящий
     * dogovor/npay.do на пустую услугу отвечает «Выберите услугу».
     *
     * Возвращает { ok, message, serviceId }.
     */
    async function addPublicIpService(cid, isLegal) {
        const id = cid || '';
        if (!id) return { ok: false, message: 'нет ID договора' };

        const existing = await findPublicIpNpayService(id, isLegal);
        if (existing) return { ok: true, message: 'уже подключена', serviceId: existing.serviceId };

        const serviceId = isLegal ? '73' : '72';
        const body = new URLSearchParams({
            method: 'update',
            contractId: String(id),
            billingId: 'bill',
            moduleId: '2',
            id: '',
            serviceId,
            data: '',
            count: '1',
            dateFrom: todayRu(),
            dateTo: '',           // бессрочно
            objectId: '0',
            comment: '',
        });

        try {
            const res = await fetch('/user/plugin/dogovor/npay.do', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body,
            });
            const text = await res.text();

            // Ответ — JSON {"status":"ok"|"error","message":"…"}
            let json = null;
            try { json = JSON.parse(text); } catch (e) { /* не JSON — разберём текстом */ }
            if (json) {
                if (json.status && json.status !== 'ok') {
                    return { ok: false, message: String(json.message || json.status).slice(0, 110) };
                }
                return { ok: true, serviceId };
            }

            const plain = String(text).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
            const err = plain.match(/(Ошибка|Exception|не найден|нельзя|Выберите)[^.]{0,90}/i);
            if (!res.ok || err) {
                return { ok: false, message: (err ? err[0] : plain).slice(0, 110) };
            }
            return { ok: true, serviceId };
        } catch (e) {
            return { ok: false, message: e.message || String(e) };
        }
    }

    /**
     * Отключение услуги «Публичный IP-адрес» из абонплаты.
     *
     * Закрываем позицию СЕГОДНЯШНИМ числом, а не удаляем.
     *
     * Раньше здесь стоял npay.do?method=serviceDelete — позиция исчезала из
     * списка бесследно. Оператор не мог ответить абоненту «когда услугу сняли»
     * и не видел её в истории: в биллинге не оставалось никаких следов.
     * Договор же ведут годами, и такие следы нужны — при разборе жалобы,
     * при сверке начислений, при повторном подключении.
     *
     * Поэтому идём тем же путём, что и оператор вручную: открываем форму
     * услуги (serviceGet) и сохраняем её с dateTo = сегодня. Позиция остаётся
     * в списке закрытой, тарификация прекращается с текущей даты.
     *
     * Возвращает { ok, message }.
     */
    async function removePublicIpService(cid, isLegal) {
        const id = cid || '';
        if (!id) return { ok: true, message: 'нет услуги' };

        const existing = await findPublicIpNpayService(id, isLegal);
        if (!existing) return { ok: true, message: 'услуги не было' };

        try {
            // Читаем позицию: serviceUpdate требует все поля, иначе биллинг
            // потеряет количество и объект. Форма отдаёт их готовыми.
            const readUrl = '/user/plugin/bgbilling/proto/npay.do'
                + `?id=${encodeURIComponent(existing.id)}&method=serviceGet`
                + `&contractId=${encodeURIComponent(id)}&billingId=bill&moduleId=2`;
            const html = await fetchText(readUrl);
            const form = parseHtml(html).querySelector('form');
            if (!form) return { ok: false, message: 'услуга не найдена в абонплате' };

            const val = (n) => {
                const el = form.elements[n];
                return el ? String(el.value || '') : '';
            };

            const body = new URLSearchParams({
                method: 'update',
                contractId: String(id),
                billingId: 'bill',
                moduleId: '2',
                id: String(existing.id),
                serviceId: val('serviceId') || existing.serviceId,
                data: val('data'),
                count: val('count') || '1',
                dateFrom: val('dateFrom'),
                // Сегодняшним числом: тарификация прекращается с текущей даты,
                // а запись остаётся в списке закрытой.
                dateTo: todayRu(),
                objectId: val('objectId') || '0',
                comment: 'Снятие белого IP',
            });

            const res = await fetch('/user/plugin/dogovor/npay.do', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body,
            });
            const text = await res.text();

            // Ответ — JSON {"status":"ok"|"error","message":"…"}
            let json = null;
            try { json = JSON.parse(text); } catch (e) { /* не JSON — разберём текстом */ }
            if (json) {
                if (json.status && json.status !== 'ok') {
                    return { ok: false, message: String(json.message || json.status).slice(0, 110) };
                }
                return { ok: true, message: 'услуга закрыта сегодняшним числом' };
            }

            const plain = String(text).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
            const err = plain.match(/(Ошибка|Exception|не найден|Выберите)[^.]{0,90}/i);
            if (!res.ok || err) {
                return { ok: false, message: (err ? err[0] : plain).slice(0, 110) };
            }
            return { ok: true, message: 'услуга закрыта сегодняшним числом' };
        } catch (e) {
            return { ok: false, message: e.message || String(e) };
        }
    }

    /**
     * Ошибки Radius Logs внутри карточки «Сессия и подключение».
     *
     * Раньше это был отдельный блок. Объединили, потому что сессия и ошибка
     * авторизации — один RADIUS-обмен: Accept даёт сессию, Reject даёт ошибку.
     * Теперь это третья вкладка рядом с «Активные» и «История».
     *
     * Колонки таблицы ERP (Договор | Устройство | Сервис | Время | Ошибка | Кол-во)
     * переводим в человеческий вид: код ошибки расшифровываем по таблице BGBilling
     * (bgbilling.ru/versions/v7.2/doc/43385928.html) и группируем по смыслу.
     */
    async function loadRadiusErrors(panel, cid) {
        const generation = genOf(panel);
        const data = await ERP.radiusErrors(cid);

        if (genOf(panel) !== generation) return null;
        if (!document.contains(panel)) return null;

        const card = panel.querySelector('.tp-sessions');
        const rows = (data && data.rows) || [];

        // Счётчик ошибок в самой вкладке. В шапке карточки цифры больше нет:
        // она дублировала «Активные» и мешала рядом с «Онлайн»/«Офлайн».
        panel._tpErrRows = rows;
        applyTabCounts(panel);

        // HTML ошибок кэшируем на панели: контейнер вкладки создаётся при первом
        // ответе сессий, а ошибки могут прийти раньше (запросы идут параллельно).
        const buildHtml = () => {
            if (!rows.length) {
                return data && data.noContractNumber
                    ? '<div class="tp-hint">Не удалось определить номер договора — ошибки Radius не запрошены.</div>'
                    : '<div class="tp-sess-empty">За последние 24 ч ошибок подключения нет.</div>';
            }
            return renderRadiusErrors(rows, data.title);
        };

        panel._tpErrData = data;

        const body = card && card.querySelector('.tp-err-body');
        const nextHtml = buildHtml();
        if (!body) {
            panel._tpErrHtml = nextHtml;
            return data;
        }

        // Данные те же — разметку не трогаем вовсе. Иначе каждые 7 секунд
        // список ошибок пересобирался, а вместе с ним сбрасывались
        // раскрытые RADIUS-логи и мигали пароли.
        if (body.__tpHtml === nextHtml) {
            panel._tpErrHtml = nextHtml;
            return data;
        }

        // Перед перерисовкой сохраняем уже загруженные inline-блоки: автоопрос
        // идёт раз в 7 секунд, и без этого пароли мигали бы «Загрузка…» каждый раз.
        const loaded = new Map();
        body.querySelectorAll('.tp-err-inline[data-log-url]').forEach((el) => {
            if (el.querySelector('.tp-radlog-row, .tp-radlog-hint')) {
                loaded.set(el.dataset.logUrl, el.innerHTML);
            }
        });

        setHtmlIfChanged(body, nextHtml);
        panel._tpErrHtml = nextHtml;

        // Возвращаем загруженные блоки на место — без повторных запросов
        body.querySelectorAll('.tp-err-inline[data-log-url]').forEach((el) => {
            const html = loaded.get(el.dataset.logUrl);
            if (html) el.innerHTML = html;
        });
        mountPasswords(panel);

        // Догружаем то, чего ещё нет в кэше
        fillRadiusInline(panel, body).catch(() => {});

        return data;
    }

    /**
     * «Доступы» внутри карточки «Сессия и подключение».
     *
     * Пароли — часть доступа к сервису, поэтому живут в сессиях: отдельный блок
     * «Пароли» повторял логин, IP и название сервиса.
     *
     * Участвует в автообновлении, поэтому: запрос паролей кэшируется на панели,
     * а готовая разметка сохраняется в panel._tpAccessHtml — слот может ещё
     * не существовать, когда ответ придёт.
     */
    async function loadAccesses(panel, cid) {
        const generation = genOf(panel);
        const id = cid || panel.dataset.contractId;
        if (!id) return null;

        if (!panel._tpPwdCache) panel._tpPwdCache = new Map();
        let pwdData = panel._tpPwdCache.get(id);
        if (!pwdData) {
            // Через общий кэш панели: тот же contractCards мог понадобиться
            // «Белому IP» (логин/пароль) и inline-блоку RADIUS-лога.
            pwdData = await erpOnce(panel, 'passwords', () => ERP.passwords(id)).catch(() => null);
            if (!pwdData) return null;
            panel._tpPwdCache.set(id, pwdData);
        }

        if (genOf(panel) !== generation) return null;
        if (!document.contains(panel)) return null;

        const rows = [];
        if (pwdData.stats) {
            // kind:'stat' — служебная строка: она не участвует в выборе статуса
            // и в счётчике сервисов. Пароль статистики и пароль PPPoE в биллинге
            // часто совпадают (на AV0000001 оба 000666), поэтому различить их
            // по значению невозможно — различаем по происхождению строки.
            rows.push({ kind: 'stat', name: 'Статистика', state: '', value: pwdData.stats });
        }
        (pwdData.accounts || []).forEach((a) => {
            if (!a.password) return;
            // Статус аккаунта ТВ считается по ОБОИМ полям. Раньше смотрели
            // только state, из-за чего аккаунт «открыт/удален» показывался
            // как действующий, и оператор мог отправить абоненту пароль
            // удалённого аккаунта.
            const rank = svcRank(a);
            // ERP уже отдаёт имя аккаунта с префиксом «ТВ» («ТВ bg3»),
            // поэтому добавляем свой только если его там нет — иначе
            // получалось «ТВ ТВ bg3».
            //
            // Проверяем именно пробел после «ТВ», а не \b: в JavaScript
            // граница слова считается по \w (латиница, цифры, «_»),
            // и кириллица в него не входит — /^ТВ\b/ не срабатывает никогда.
            const nm = String(a.name || '').trim();
            rows.push({
                kind: 'tv',
                name: /^ТВ(\s|$)/i.test(nm) ? nm : `ТВ ${nm}`,
                rank,
                state: rank === 2 ? 'удалён' : rank === 1 ? 'отключён' : '',
                value: a.password,
            });
        });
        (pwdData.services || []).forEach((s) => {
            if (!s.password) return;
            const rank = svcRank(s);
            // В названии сервиса ERP повторяет номер договора и IP — они уже
            // в шапке карточки и в списке сессий. Оставляем тип и имя.
            const cleanName = cleanBillServiceName(s.name, { dropLogin: true, dropAddr: true });
            const label = [s.type, cleanName].filter(Boolean).join(' ') || 'Интернет';
            rows.push({
                kind: 'svc',
                name: label,
                rank,
                state: rank === 2 ? 'удалён' : rank === 1 ? 'закрыт' : '',
                value: s.password,
            });
        });

        // Один и тот же пароль часто выдан и на статистику, и на PPPoE:
        // показываем его один раз, склеивая подписи.
        //
        // Подписи склеиваем БЕЗ повторов. В биллинге на договоре копятся
        // закрытые сервисы с тем же паролем: у AV0000001 их 27, и строка
        // превращалась в «Статистика · PPPoE · PPPoE …».
        //
        // Статус берём по САМОМУ ЖИВОМУ сервису, а не по первому встреченному.
        // Раньше побеждал первый, а таблица идёт от старых к новым — поэтому
        // к строке приклеивался статус давно удалённого сервиса, и оператор
        // видел «Статистика · PPPoE закрыт» при действующем PPPoE.
        const byValue = new Map();
        rows.forEach((r) => {
            const key = String(r.value);
            const prev = byValue.get(key);
            if (!prev) {
                byValue.set(key, {
                    value: r.value,
                    labels: [r.name],
                    // Infinity — «статуса нет»: служебная строка не должна
                    // становиться лучшим статусом только из-за пустого rank.
                    rank: r.kind === 'stat' ? Infinity : r.rank,
                    total: r.kind === 'stat' ? 0 : 1,
                    alive: (r.kind !== 'stat' && r.rank === 0) ? 1 : 0,
                    // Признак «в этой строке есть пароль статистики» запоминаем
                    // отдельно от rank. Раньше его выводили из rank === Infinity,
                    // и на договорах, где пароль статистики СОВПАДАЕТ с PPPoE
                    // (BILL0042493: оба 677048), склейка по значению подмешивала
                    // rank живого сервиса — строка переставала быть «stat»,
                    // блоку «Отправить на почту» было нечего взять, и в письме
                    // под подписью «личный кабинет» стоял прочерк.
                    isStat: r.kind === 'stat',
                });
                return;
            }
            if (r.name && prev.labels.indexOf(r.name) < 0) prev.labels.push(r.name);
            if (r.kind === 'stat') { prev.isStat = true; return; }
            prev.total += 1;
            if (r.rank === 0) prev.alive += 1;
            prev.rank = Math.min(prev.rank, r.rank);
        });
        const uniq = Array.from(byValue.values()).map((r) => ({
            name: r.labels.filter(Boolean).join(' · '),
            state: r.rank === 0 ? 'действует'
                : r.rank === 1 ? 'закрыт'
                    : r.rank === 2 ? 'удалён' : '',
            good: r.rank === 0,
            // Пароль статистики помечаем явно: по значению его не отличить
            // от пароля PPPoE (в биллинге они часто совпадают), а блоку
            // «Отправить на почту» нужно взять именно его.
            kind: r.isStat ? 'stat' : 'svc',
            count: r.total > 1 ? { alive: r.alive, total: r.total } : null,
            value: r.value,
        }));

        if (!uniq.length) {
            panel._tpAccessHtml = '';
            const slot = panel.querySelector('[data-role="access-slot"]');
            if (slot) slot.innerHTML = '';
            return [];
        }

        let html = '<div class="tp-access-title">Доступы</div>';
        uniq.forEach((r) => {
            const stateCls = r.good ? ' is-good' : '';
            const cnt = r.count
                ? ` <span class="tp-pwd-count" title="Действующих ${r.count.alive} из ${r.count.total} записей">${r.count.alive} из ${r.count.total}</span>`
                : '';
            html += `<div class="tp-pwd-row"${r.kind === 'stat' ? ' data-kind="stat"' : ''}>
                <span class="tp-pwd-name" title="${esc(r.name)}">${esc(r.name)}${r.state ? ` <span class="tp-pwd-state${stateCls}">${esc(r.state)}</span>` : ''}${cnt}</span>
                <span class="tp-pwd-val" data-pwd="${esc(r.value)}" tabindex="0" title="Нажмите, чтобы скопировать">${esc(r.value)}</span>
            </div>`;
        });

        panel._tpAccessHtml = html;
        const slot = panel.querySelector('[data-role="access-slot"]');
        if (slot) {
            slot.innerHTML = html;
            mountPasswords(panel);
        }
        return uniq;
    }

    /**
     * Расшифровка кодов ошибок авторизации BGBilling.
     * Источник: bgbilling.ru/versions/v7.2/doc/43385928.html — «Коды ошибок».
     * Нужна, чтобы вместо «[11] Договор приостановлен» группировать ошибки
     * по причине и подсказывать, что делать.
     */
    const RADIUS_ERROR_KINDS = {
        1: { key: 'login', title: 'Логин не найден', hint: 'Роутер присылает логин, которого нет в биллинге. Проверьте логин в настройках подключения.' },
        2: { key: 'password', title: 'Неверный пароль', hint: 'Пароль на роутере не совпадает с биллингом. Смотрите раскрытый лог: там оба пароля.' },
        3: { key: 'limit', title: 'Превышен лимит сессий', hint: 'У сервиса больше соединений, чем разрешено. Закройте зависшие сессии.' },
        4: { key: 'period', title: 'Учётный период не активирован', hint: 'У договора не активирован учётный период в биллинге.' },
        10: { key: 'blocked', title: 'Сервис заблокирован', hint: 'Сервис заблокирован в биллинге.' },
        11: { key: 'blocked', title: 'Договор заблокирован', hint: 'Договор приостановлен или заблокирован — проверьте баланс и статус.' },
        12: { key: 'money', title: 'Недостаточно средств', hint: 'Баланс ниже лимита. Нужен платёж или доверительный лимит.' },
        20: { key: 'blocked', title: 'Статус сервиса закрыт', hint: 'Сервис закрыт или заблокирован в биллинге.' },
        30: { key: 'card', title: 'Карта просрочена', hint: 'Истёк срок действия карты доступа.' },
        31: { key: 'card', title: 'Карта заблокирована', hint: 'Карта доступа заблокирована.' },
        40: { key: 'nas', title: 'Доступ к NAS закрыт', hint: 'Роутеру запрещена авторизация — проверьте настройки устройства.' },
        43: { key: 'nas', title: 'Реалм запрещён', hint: 'Реалм запрещён в настройках NAS.' },
        44: { key: 'blocked', title: 'Доступ приостановлен', hint: 'Доступ приостановлен в биллинге.' },
        46: { key: 'mac', title: 'MAC-адрес запрещён', hint: 'MAC роутера запрещён — сверьте с привязкой.' },
        62: { key: 'tariff', title: 'Не определён тарифный план', hint: 'У договора нет тарифного плана на дату авторизации.' },
        63: { key: 'tariff', title: 'Не определена цена в тарифе', hint: 'В тарифном плане не найдена цена услуги.' },
        80: { key: 'ip', title: 'Свободный IP не найден', hint: 'В пуле не осталось свободных адресов для этого сервиса.' },
    };

    /** Порядок групп: от «оператор может исправить» к «нужно вмешательство биллинга». */
    const RADIUS_KIND_ORDER = ['password', 'login', 'limit', 'money', 'blocked', 'tariff', 'ip', 'nas', 'mac', 'card', 'period', 'other'];

    /** Разбирает строку «[11] Договор приостановлен» на код и текст. */
    function parseRadiusError(text) {
        const m = String(text || '').match(/^\[(\d+)\]\s*(.*)$/);
        if (!m) return { code: '', title: String(text || ''), kind: 'other' };
        const code = Number(m[1]);
        const known = RADIUS_ERROR_KINDS[code];
        return {
            code,
            title: m[2] || (known ? known.title : ''),
            kind: known ? known.key : 'other',
            hint: known ? known.hint : '',
        };
    }

    /**
     * Ошибки подключения, сгруппированные по причине.
     *
     * Одних и тех же ошибок за сутки бывает сотни (роутер долбится каждые
     * несколько секунд), поэтому вместо плоского списка показываем группы:
     * одна причина — одна строка с количеством и последним временем.
     * Внутри группы строки раскрываются в RADIUS-лог (для «Неверный пароль»
     * там видно оба пароля).
     */
    function renderRadiusErrors(rows, contractTitle) {
        const groups = new Map();
        rows.forEach((r) => {
            const p = parseRadiusError(r.error);
            if (!groups.has(p.kind)) {
                groups.set(p.kind, { kind: p.kind, title: p.title, hint: p.hint, items: [], total: 0, last: '' });
            }
            const g = groups.get(p.kind);
            g.items.push({ ...r, parsed: p });
            // «Кол-во» — сколько раз повторилась ошибка, а не число строк
            g.total += Number(String(r.count).replace(/\D/g, '')) || 1;
            if (!g.last || toTsSafe(r.time) > toTsSafe(g.last)) g.last = r.time;
        });

        const list = Array.from(groups.values()).sort((a, b) => {
            const ia = RADIUS_KIND_ORDER.indexOf(a.kind);
            const ib = RADIUS_KIND_ORDER.indexOf(b.kind);
            return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
        });

        let html = '';
        list.forEach((g) => {
            // Внутри группы — до 5 последних записей: больше не нужно, они однотипные
            const items = g.items.slice().sort((a, b) => toTsSafe(b.time) - toTsSafe(a.time)).slice(0, 5);

            // Для пароля и логина RADIUS-лог объясняет причину полностью, поэтому
            // вместо списка одинаковых строк показываем один блок: устройство,
            // MAC, порт и оба пароля. Без вложенных уровней и без подсказки —
            // вердикт уже внутри блока, второй такой же текст не нужен.
            const logItem = items.find((r) => r.logUrl);
            const isLogGroup = (g.kind === 'password' || g.kind === 'login') && !!logItem;

            html += `<div class="tp-errgroup" data-kind="${esc(g.kind)}">
                <div class="tp-errgroup-head">
                    <div class="tp-errgroup-main">
                        <div class="tp-errgroup-title">${esc(g.title)}</div>
                        <div class="tp-errgroup-meta">${esc(g.last)}${g.total > 1 ? ` · ${esc(String(g.total))} раз` : ''}</div>
                    </div>
                    <div class="tp-errgroup-count">${esc(String(g.items.length))}</div>
                </div>`;

            if (isLogGroup) {
                // Один блок вместо дерева: MAC, порт, оба пароля и короткий вердикт
                html += `<div class="tp-err-inline" data-log-url="${esc(logItem.logUrl)}">
                    <div class="tp-loading" style="padding:4px 0">Загрузка…</div>
                </div>`;
            } else {
                if (g.hint) html += `<div class="tp-errgroup-hint">${esc(g.hint)}</div>`;
                html += '<div class="tp-errgroup-body">';
                items.forEach((r) => {
                    const deviceShort = String(r.device || '')
                        .replace(/^BRAS\s+Cisco:\s*/i, '')
                        .replace(/\s*\[[^\]]+\]\s*$/, '')
                        .trim();
                    // В «Сервисе» ERP повторяет номер договора и IP — они уже есть выше
                    const service = String(r.service || '')
                        .replace(new RegExp('\\b' + String(contractTitle || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi'), '')
                        .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '')
                        .replace(/\s+/g, ' ')
                        .trim();

                    // Время уже в шапке группы — в строке оставляем только устройство
                    html += `<div class="tp-err-row">
                        <div class="tp-err-msg">${esc(deviceShort || '—')}</div>
                        ${r.count ? `<div class="tp-err-count">×${esc(r.count)}</div>` : ''}
                        ${service ? `<div class="tp-err-meta">${esc(service)}</div>` : ''}
                    </div>`;
                });
                html += '</div>';
            }
            html += '</div>';
        });

        return html;
    }

    /** Время ERP «dd.MM.yyyy HH:mm:ss» > timestamp для сортировки. */
    function toTsSafe(t) {
        const m = String(t || '').match(/(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?/);
        if (!m) return 0;
        return new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +(m[6] || 0)).getTime() || 0;
    }

    /**
     * Пароль из биллинга, относящийся именно к этому логину.
     *
     * В карточке договора пароли лежат по сервисам: ТВ, PPPoE, IPoE и т.д.
     * Раньше сравнение шло со всеми подряд и показывало первый пароль из списка —
     * из-за этого могло «совпасть» с паролем другого сервиса и дать ложный вердикт.
     *
     * Сопоставляем по имени сервиса: в RADIUS-логе User-Name — это логин сервиса
     * (например AGB0002323), и он же стоит в названии сервиса в карточке.
     */
    function pickBillingPassword(pwdData, userName) {
        const all = [
            ...((pwdData && pwdData.services) || []).map((s) => ({ ...s, kind: s.type || 'Интернет' })),
            ...((pwdData && pwdData.accounts) || []).map((a) => ({ ...a, kind: 'ТВ' })),
        ].filter((e) => e.password);

        if (!all.length) return null;

        // Действующие сервисы — в приоритете. Таблица в карточке идёт от
        // старых записей к новым, поэтому entries.find() возвращал пароль
        // САМОГО СТАРОГО сервиса: на договоре, где пароль меняли, вердикт
        // «пароль в биллинге» в RADIUS-логе был ложным.
        const alive = all.filter((e) => isAliveService(e));
        const entries = alive.length ? alive : all;

        const login = String(userName || '').trim().toLowerCase();
        if (login) {
            // 1) имя сервиса содержит логин из лога
            const byName = entries.find((e) => String(e.name || '').toLowerCase().includes(login));
            if (byName) return byName;
            // 2) логин встречается где-то в строке сервиса (например «BILL0012056 10.0.0.1»)
            const byAny = entries.find((e) => String(e.name || '').toLowerCase().split(/\s+/).includes(login));
            if (byAny) return byAny;
        }
        // 3) иначе — интернет-сервис: ошибка пароля почти всегда про него
        const internet = entries.find((e) => /pppoe|ipoe|pptp|l2tp|интернет/i.test(e.kind + ' ' + (e.name || '')));
        return internet || entries[0];
    }

    /**
     * Заполнение inline-блоков ошибок без клика.
     *
     * Для «[2] Неверный пароль» список ошибок говорит только «пароль не тот».
     * В RADIUS-логе видно, ЧТО прислал роутер и что лежит в биллинге — это
     * и показываем сразу под строкой, без раскрытия.
     *
     * Логов на договоре бывает много (сотни записей), и каждый — отдельный
     * запрос к ERP. Поэтому:
     *  - обогащаем только по одному блоку на группу (в разметке он уже один);
     *  - кэш на панели в пределах поколения: автоопрос раз в 7 секунд не
     *    порождает новых запросов, пока лог не изменится.
     */
    async function fillRadiusInline(panel, root) {
        const blocks = Array.from(root.querySelectorAll('.tp-err-inline[data-log-url]'));
        if (!blocks.length) return;

        if (!panel._tpLogCache) panel._tpLogCache = new Map();
        if (!panel._tpPwdCache) panel._tpPwdCache = new Map();

        const generation = genOf(panel);

        await Promise.all(blocks.map(async (el) => {
            const url = el.dataset.logUrl;
            if (!url) return;

            try {
                let v = panel._tpLogCache.get(url);
                if (!v) {
                    const log = await ERP.radiusRequestLog(url);
                    if (!log) {
                        el.innerHTML = '<div class="tp-hint">Лог недоступен.</div>';
                        return;
                    }

                    // Пароли договора кэшируем отдельно: на один договор их
                    // запрашиваем один раз, а не под каждый лог.
                    const cid = panel.dataset.contractId;
                    let pwdData = panel._tpPwdCache.get(cid);
                    if (!pwdData) {
                        pwdData = await ERP.passwords(cid).catch(() => null);
                        if (pwdData) panel._tpPwdCache.set(cid, pwdData);
                    }

                    const billing = pwdData ? pickBillingPassword(pwdData, log.userName) : null;
                    const routerPass = String(log.password || '');
                    const billingPass = billing ? String(billing.password) : '';
                    v = {
                        log,
                        billing,
                        routerPass,
                        billingPass,
                        match: !!(routerPass && billingPass && routerPass === billingPass),
                    };
                    panel._tpLogCache.set(url, v);
                }

                // Панель перерисовали, пока шёл запрос — ответ уже некуда вставлять
                if (genOf(panel) !== generation) return;
                if (!document.contains(el)) return;

                el.innerHTML = renderRadiusInline(v);
                mountPasswords(panel);
            } catch (e) {
                if (!document.contains(el)) return;
                el.innerHTML = `<div class="tp-err">Не удалось загрузить лог: ${esc(e.message || e)}</div>`;
            }
        }));
    }

    /**
     * Inline-блок ошибки: MAC, порт и оба пароля.
     *
     * Минимализм: одна строка на факт, без подсказок и без кода ошибки —
     * название и код уже в заголовке группы, а вердикт виден по цвету паролей
     * (красный — что прислал роутер, зелёный — что лежит в биллинге).
     */
    function renderRadiusInline(v) {
        const { log, routerPass, billingPass } = v;
        let html = '';

        if (log.mac) {
            html += `<div class="tp-radlog-row"><span>MAC</span><b>${esc(log.mac)}</b></div>`;
        }
        if (log.nasPort) {
            html += `<div class="tp-radlog-row"><span>Порт</span><b>${esc(log.nasPort)}</b></div>`;
        }

        // Пароли открытые, по клику копируются (mountPasswords)
        if (routerPass) {
            html += `<div class="tp-radlog-row is-bad">
                <span>Пароль авторизации роутера</span>
                <b><span class="tp-pwd-val" data-pwd="${esc(routerPass)}" title="Нажмите, чтобы скопировать">${esc(routerPass)}</span></b>
            </div>`;
        }
        if (billingPass) {
            html += `<div class="tp-radlog-row is-ok">
                <span>Пароль в биллинге</span>
                <b><span class="tp-pwd-val" data-pwd="${esc(billingPass)}" title="Нажмите, чтобы скопировать">${esc(billingPass)}</span></b>
            </div>`;
        }

        // Вердикт виден по цвету паролей, поэтому подсказку «на роутере старый
        // пароль» не пишем. Оставляем текст только когда сравнить не с чем —
        // иначе оператор не поймёт, почему нет второго пароля.
        if (routerPass && !billingPass) {
            html += '<div class="tp-radlog-hint">Пароля в биллинге нет — сравнить не с чем.</div>';
        } else if (!routerPass) {
            html += '<div class="tp-radlog-hint">Роутер не прислал пароль.</div>';
        }

        return html;
    }

    /** Блок «Состояние связи» — перерисовывается, когда пришли сессии. */
    /**
     * HTML блока «Состояние связи».
     * Две независимых строки: есть ли живая сессия (Онлайн/Офлайн) и
     * блокировка по деньгам, плюс крупная сумма к внесению и прогноз.
     */
    /**
     * Денежная часть карточки действий: вердикт по балансу, сумма к внесению,
     * факты (запас, лимит) и прогноз блокировки.
     *
     * Раньше здесь была ещё строка «Онлайн/Офлайн» — но это данные сессий,
     * и они дублировались: оператор видел одно и то же в двух карточках.
     * Онлайн теперь живёт в заголовке «Сессии», а тут только деньги.
     *
     * Остаток намеренно не показываем: он есть в «Балансе за расчётный месяц».
     * Вместо него — запас (остаток − лимит), это другое число и другой смысл.
     */
    function renderMoney(opts) {
        const {
            outNum, limitNum, fee = null, pending = false, statusText = '', aliveCount = 0,
        } = opts || {};

        // Статус договора — не мелочь. По документации BGBilling статус глобальный:
        // «Закрыт» и «Приостановлен» отключают модули независимо от баланса
        // (bgbilling.ru/versions/v7.2/doc/43384998.html). Раньше сюда передавалась
        // пустая строка, и закрытый договор с положительным остатком показывался
        // как «Блокировки нет».
        const v = connectionVerdict(outNum, limitNum, statusText, aliveCount);

        let moneyClass = 'is-ok';
        // Заголовок несёт статус, ниже — только сумма. Раньше было и «Блокировки нет»,
        // и крупный «0 ₽» с подписью «Вносить не нужно» — три формулировки одного факта.
        let moneyLabel = 'Блокировки нет';
        let heroValue = '0 ₽';
        let heroCaption = 'Вносить не нужно';

        if (!v.hasData) {
            moneyClass = 'is-warn';
            moneyLabel = 'Нет данных по балансу';
            heroValue = '—';
            heroCaption = 'Не удалось прочитать остаток или лимит';
        } else if (v.isClosed) {
            // Договор закрыт: услуги отключены статусом, а не балансом.
            // Платёж тут не поможет — деньги не вернут доступ.
            moneyClass = 'is-bad';
            moneyLabel = 'Договор закрыт';
            heroValue = 'Закрыт';
            heroCaption = 'Услуги отключены статусом договора, а не балансом';
        } else if (v.isSuspended) {
            // «Заморозка», «Приостановлен», «В отключении» и любой другой
            // неактивный статус из contract.status.list. Деньги тут не помогут:
            // по документации BGBilling для дебетового договора статус ставит
            // только администратор, и поступление денег его не меняет.
            moneyClass = 'is-warn';
            moneyLabel = v.statusText ? `Статус «${v.statusText}»` : 'Договор приостановлен';
            heroValue = 'Пауза';
            heroCaption = 'Услуги на паузе по статусу договора, а не по балансу';
        } else if (v.blockedByBalance) {
            moneyClass = 'is-bad';
            moneyLabel = 'Заблокирован по балансу';
            heroValue = `${fmt(v.needPay)} ₽`;
            heroCaption = 'Внести, чтобы разблокировать';
        } else {
            // Не заблокирован — подпись не нужна: «0 ₽» и так означает «вносить нечего»
            heroCaption = '';
        }

        // Прогноз: сколько дней осталось до ухода в минус.
        // Для закрытого и приостановленного договора он бессмыслен — блокировка
        // уже наступила по статусу.
        const forecast = (v.hasData && !v.blockedByBalance && !v.isClosed && !v.isSuspended)
            ? daysUntilBlock(outNum, limitNum, fee)
            : null;

        const pendingHero = pending
            ? '<span class="tp-verdict-skel"></span>'
            : esc(heroValue);

        const perDay = trustPerDay(fee);

        const facts = v.hasData
            ? `<dl class="tp-facts">
                   <dt>Запас до блокировки</dt>
                   <dd ${v.blockedByBalance ? 'class="is-neg"' : ''}>${esc(fmt(v.headroom))} ₽</dd>
                   <dt>Лимит (ниже — блок)</dt>
                   <dd>${esc(fmt(limitNum))} ₽</dd>
                   <dt>Абонплата</dt>
                   <dd>${perDay > 0
                       ? `≈${esc(fmt(perDay))} ₽/день`
                       : '—'}</dd>
               </dl>`
            : '';

        const forecastHtml = forecast
            ? `<div class="tp-forecast ${forecast.warn ? 'is-warn' : ''}">
                   До блокировки <b>${esc(forecast.label)}</b>${forecast.days <= 365 ? ` · ~${esc(forecast.date)}` : ''}
               </div>`
            : '';

        return `<div class="tp-money">
            <div class="tp-verdict-head ${moneyClass}">
                <span class="tp-signal ${moneyClass}"></span>
                <span class="tp-verdict-label">${esc(moneyLabel)}</span>
            </div>

            <div class="tp-verdict">
                <span class="tp-verdict-value ${moneyClass}">${pendingHero}</span>
                ${heroCaption ? `<span class="tp-verdict-caption">${esc(heroCaption)}</span>` : ''}
            </div>

            ${facts}
            ${forecastHtml}
        </div>`;
    }

    /** Заполняет денежный слот карточки действий (пересчитывается при автообновлении). */
    function fillMoney(panel, ctx) {
        const slot = panel.querySelector('[data-role="money-slot"]');
        if (!slot) return;
        setHtmlIfChanged(slot, renderMoney({
            outNum: ctx.outNum,
            limitNum: ctx.limitNum,
            fee: ctx.fee || null,
            pending: !!ctx.pending,
            statusText: ctx.status || '',
            aliveCount: ctx.aliveCount || 0,
        }));
    }

    /**
     * Перерисовка денежного блока по сохранённому контексту.
     *
     * Контекст (баланс, лимит, вердикт) считается один раз в hydrate()
     * и лежит на панели: при автообновлении незачем заново дёргать параметры
     * договора. Абонплата приходит позже отдельным запросом — её тоже кэшируем.
     */
    function refreshMoney(panel) {
        const ctx = panel._tpCtx;
        if (!ctx) return;
        fillMoney(panel, {
            outNum: ctx.outNum,
            limitNum: ctx.limitNum,
            fee: panel._tpFee || null,
            // Статус обязателен: без него закрытый договор снова показывался
            // как «Блокировки нет» — денежный блок перерисовывался после
            // загрузки абонплаты и терял статус из контекста.
            status: ctx.status || '',
        });
    }

    /**
     * Проставляет счётчики всех трёх вкладок сразу.
     *
     * Раньше цифры появлялись только после клика по вкладке: история грузится
     * по требованию, а счётчик обновлялся в renderSessions, который для неё
     * ещё не вызывался. Оператор не видел, есть ли там что-то, пока не откроет.
     */
    function applyTabCounts(panel) {
        const container = panel.querySelector('.tp-sessions');
        if (!container) return;

        const set = (role, n) => {
            const el = container.querySelector(`[data-role="${role}"]`);
            if (!el) return;
            const has = Number(n) > 0;
            // Сверяем перед записью: функция вызывается на каждый тик автообновления,
            // а счётчики меняются раз в несколько минут.
            const text = has ? String(n) : '';
            if (el.textContent !== text) el.textContent = text;
            if (el.hidden !== !has) el.hidden = !has;
            el.classList.toggle('is-on', has);
        };

        set('alive-count', panel._tpAliveCount || 0);
        set('history-count', panel._tpHistoryCount || 0);
        set('err-count', (panel._tpErrRows || []).length);
    }

    /**
     * Фоновая загрузка количества сессий в истории — только чтобы показать
     * цифру на вкладке. Список не рисуем: при клике loadSessions загрузит его
     * заново с нужной сортировкой и подсветкой новых записей.
     */
    async function loadHistoryCount(panel, cid) {
        const id = cid || panel.dataset.contractId;
        if (!id) return null;

        const generation = genOf(panel);
        const data = await ERP.sessions('history', id).catch(() => null);
        if (!data) return null;
        if (genOf(panel) !== generation) return null;
        if (!document.contains(panel)) return null;

        panel._tpHistoryCount = (data.rows || []).length;
        applyTabCounts(panel);
        return data;
    }

    /** Дорисовывает сессии внутри своей карточки — уже с готовым списком активных. */
    function renderSessionsInto(panel, aliveSessions) {
        const card = panel.querySelector('.tp-sessions');
        if (!card) return;

        if (!card.querySelector('.tp-sess-head')) {
            const rows = (aliveSessions && aliveSessions.rows) || [];
            // Пишем только в тело карточки: заголовок «Сессия» с бейджем
            // «Онлайн/Офлайн» и индикатором автообновления нарисован в каркасе,
            // и card.innerHTML его затирал.
            const body = card.querySelector('.tp-lazy-body');
            if (!body) return;
            body.innerHTML = `<div class="tp-sess-head">
                    <div class="tp-tabs-mini">
                        <button type="button" class="is-on" data-kind="alive">
                            Активные <span class="tp-count ${rows.length ? 'is-on' : ''}" data-role="alive-count">${rows.length}</span>
                        </button>
                        <button type="button" data-kind="history">
                            История <span class="tp-count" data-role="history-count" hidden></span>
                        </button>
                        <button type="button" data-kind="errors">
                            Ошибки <span class="tp-count" data-role="err-count" hidden></span>
                        </button>
                    </div>
                </div>
                <div class="tp-sess-body"></div>
                <div class="tp-err-body" hidden></div>
                <div class="tp-access" data-role="access-slot"></div>`;
            card.classList.add('is-filled');

            // Счётчики вкладок подставляем сразу, не дожидаясь клика:
            // иначе цифры появлялись только после переключения, и было непонятно,
            // есть ли вообще история и ошибки.
            applyTabCounts(panel);

            // Ошибки могли прийти раньше, чем появился контейнер вкладки
            if (panel._tpErrHtml) {
                const errBody = body.querySelector('.tp-err-body');
                if (errBody) {
                    errBody.innerHTML = panel._tpErrHtml;
                    mountPasswords(panel);
                    fillRadiusInline(panel, errBody).catch(() => {});
                }
            }

            // Пароли могли прийти раньше, чем появился слот (запросы идут параллельно)
            if (panel._tpAccessHtml) {
                const slot = body.querySelector('[data-role="access-slot"]');
                if (slot) {
                    slot.innerHTML = panel._tpAccessHtml;
                    mountPasswords(panel);
                }
            }
        }

        // Разметка готова — только теперь навешиваем обработчики.
        // Раньше mountSessions вызывался до перерисовки: он вешался на старый скелетон,
        // а после innerHTML кнопки оставались без слушателей.
        // Передаём уже полученные активные сессии — второй такой же запрос не нужен.
        mountSessions(panel, aliveSessions);

        renderSessions(card, aliveSessions, true);
    }

    /**
     * Фоновая догрузка всех блоков. Запускается сразу после вставки каркаса,
     * блоки заполняются по мере готовности — независимо друг от друга.
     */
    async function hydrate(panel) {
        const id = panel.dataset.contractId || ERP.contractId(panel.closest('#content > div[id^="contract_bill-"]'));
        if (!id) return;

        const generation = genOf(panel);
        const alive = (name, promise, render) => {
            promise
                .then((data) => {
                    if (genOf(panel) !== generation) return;
                    if (!document.contains(panel)) return;
                    render(data);
                })
                .catch((e) => {
                    if (genOf(panel) !== generation) return;
                    if (!document.contains(panel)) return;
                    fillLazy(panel, name, `<div class="tp-err">Ошибка: ${esc(e.message || e)}</div>`);
                });
        };

        // cid обязателен: без него params() читает #treeTable всех открытых карточек.
        // Если buildContent уже разобрал таблицу — берём готовое, не читая
        // живой DOM повторно.
        const params = panel._tpParams || await ERP.params(id);
        const outNum = toNum(params.balanceOut);
        const limitNum = toNum(params.limit);
        const status = params.status || '';
        const v = connectionVerdict(outNum, limitNum, status, 0);

        // Контекст «Состояния связи» — нужен автообновлению, чтобы не перезапрашивать
        // параметры договора и историю статусов каждые несколько секунд.
        panel._tpCtx = { outNum, limitNum, status, mode: params.mode, v };

        // Денежный блок снимаем со скелетона СРАЗУ, ещё до запроса абонплаты.
        //
        // Каркас рисует его с pending: true, то есть с серой заглушкой вместо
        // суммы. Снимал заглушку только applyForecast() — а он ждал stoimost.do
        // и раньше вообще выходил без перерисовки, если абонплата не разобралась
        // или равнялась нулю. В итоге у договора без начислений в «Доверительном
        // платеже» навсегда висела полоса загрузки, хотя запас и лимит рядом
        // были уже посчитаны. Теперь базовая отрисовка не зависит от сети:
        // цена дня и прогноз доедут позже, когда придёт feePromise.
        refreshMoney(panel);

        // Абонплата нужна и состоянию связи (прогноз блокировки), и доверительному платежу.
        // Берём один раз, чтобы не дёргать stoimost.do дважды.
        const feePromise = feeProfile(id).catch(() => ({ perDay: 0, perMonth: 0, source: '' }));

        /*
         * Общие промисы на одну отрисовку.
         *
         * Ниже одни и те же ручки нужны нескольким блокам: balance.do — балансу,
         * доверительному платежу и «Разовым услугам»; limitInfo — блоку «Лимит»
         * и тому же доверительному платежу; serviceTree — сессиям, «Белому IP»
         * и «Сервисам». Раньше каждый блок заказывал свою копию, и на открытие
         * договора уходило до тридцати запросов вместо пятнадцати.
         * Кэш на панели живёт до перерисовки (см. applyContent).
         */
        const balanceOnce = () => erpOnce(panel, 'balance', () => ERP.balance(id));
        const limitOnce = () => erpOnce(panel, 'limit', () => ERP.limitInfo(id));
        const servicesOnce = () => erpOnce(panel, 'services', () => ERP.services(id));

        // Прогноз требует абонплату, она приходит отдельным запросом.
        // Досчитываем цену дня и дату блокировки один раз, когда пришла.
        //
        // Раньше здесь стоял `if (!(fee > 0)) return;` — и это была ловушка:
        // денежный блок рисуется в каркасе с pending: true (то есть скелетоном),
        // а снимает скелетон ТОЛЬКО эта перерисовка. У договора без начислений
        // (тариф 0, всё закрыто, услуг нет) feeProfile() честно возвращает нули,
        // условие не проходило, refreshMoney не вызывался — и в «Доверительном
        // платеже» навсегда оставалась серая полоса загрузки, хотя рядом
        // «Запас до блокировки» и «Лимит» уже были заполнены.
        // Теперь перерисовываем всегда: 0 — это тоже данные, а не отсутствие ответа.
        const applyForecast = (fee) => {
            if (!document.contains(panel)) return;
            // Кэшируем для автообновления: денежный блок перерисовывается
            // каждые несколько секунд и должен сохранять ту же абонплату
            panel._tpFee = (fee && trustPerDay(fee) > 0) ? fee : null;
            refreshMoney(panel);
        };

        // Быстрые блоки запускаем сразу, тяжёлые — тоже, но они просто придут позже.
        // Сессии сами ставят в шапке «Онлайн/Офлайн» — отдельный блок «Состояние связи»
        // для этого был не нужен.
        alive('sessions', ERP.sessions('alive', id), (data) => {
            panel._tpAliveCount = (data && data.rows ? data.rows.length : 0);
            renderSessionsInto(panel, data);
            applyTabCounts(panel);
        });

        // Цифра на вкладке «История» должна быть видна сразу, а не после клика.
        // Грузим только количество — сам список подтянется при открытии вкладки.
        loadHistoryCount(panel, id).catch(() => {});

        feePromise.then(applyForecast);

        alive('equipment', Promise.all([
            ERP.equipment(id).catch(() => []),
            ERP.getolt(id).catch(() => ({ ok: false, onu: [], reason: 'fetch-failed' })),
        ]), ([objects, olt]) => {
            const onu = (olt && olt.onu) || [];
            if (!onu.length && !(objects && objects.length)) {
                // Плагин мог быть недоступен по правам — честно говорим об этом,
                // а не «оборудование не привязано», что вводило бы в заблуждение
                const reason = olt && olt.reason;
                const hint = reason === 'no-access' || reason === 'no-link'
                    ? 'Нет доступа к GetOLT — показать ONU нельзя. Оборудование в биллинге не привязано.'
                    : 'Оборудование не привязано.';
                fillLazy(panel, 'equipment', `<div class="tp-hint">${hint}</div>`);
                return;
            }
            let html = renderEquipment(onu, objects);
            // GetOLT недоступен, но объекты есть — предупреждаем, чтобы оператор
            // не решил, что ONU нет вовсе
            if (!onu.length && olt && (olt.reason === 'no-access' || olt.reason === 'no-link')) {
                html += '<div class="tp-hint">Данные ONU из GetOLT недоступны (нет доступа к плагину).</div>';
            }
            fillLazy(panel, 'equipment', html);
            // Адрес OLT в блоке кликабелен — вешаем копирование после вставки
            bindCopyTargets(panel);
        });

        // Radius Logs > mode=errors, все окна за 24 ч по номеру договора.
        // Ошибки теперь живут вкладкой внутри «Сессия и подключение».
        loadRadiusErrors(panel, id).catch(() => {
            const body = panel.querySelector('.tp-err-body');
            if (body) body.innerHTML = '<div class="tp-err">Не удалось загрузить ошибки подключения.</div>';
        });

        // Пароли — часть доступа к сервису, поэтому живут в карточке «Сессия»:
        // отдельный блок «Пароли» повторял логин, IP и название сервиса,
        // которые уже есть в списке сессий.
        loadAccesses(panel, id).catch(() => {});

        // Белый IP: текущие публичные адреса и свободные из категории «IPoE белые»
        const whiteIpPromise = loadWhiteIp(panel, id).catch((e) => {
            // Истёкшую сессию показываем её собственным текстом: общее «не удалось
            // загрузить» оператор читает как сбой плагина и идёт искать причину.
            const lost = /Сессия ERP истекла/.test(e && e.message || '');
            fillLazy(panel, 'whiteIp', lost
                ? `<div class="tp-err">${esc(e.message)}</div>`
                : '<div class="tp-hint">Не удалось загрузить данные по белым IP.</div>');
            return null;
        });

        // Почта: логин и пароли берём из состояния «Белого IP», поэтому ждём его.
        // Отдельного запроса к биллингу блоку не нужно — только чтение DOM.
        whiteIpPromise
            .then(() => loadMail(panel, id))
            .catch((e) => {
                const lost = /Сессия ERP истекла/.test(e && e.message || '');
                fillLazy(panel, 'mail', lost
                    ? `<div class="tp-err">${esc(e.message)}</div>`
                    : '<div class="tp-hint">Не удалось подготовить письмо.</div>');
            });

        alive('balance', balanceOnce(), (bal) => {
            fillLazy(panel, 'balance', buildBalanceHtml(bal));
        });

        // Процессы договора: активные и закрытые. Два независимых запроса,
        // оба нужны сразу — цифры на вкладках не должны ждать клика.
        loadProcesses(panel, id).catch((e) => {
            const lost = /Сессия ERP истекла/.test(e && e.message || '');
            fillLazy(panel, 'processes', lost
                ? `<div class="tp-err">${esc(e.message)}</div>`
                : '<div class="tp-hint">Не удалось загрузить процессы.</div>');
        });

        // Тарифный блок: состав тарифа + разовые. Абонплата (feePromise) нужна,
        // чтобы отделить тарифные начисления от разовых за прошлые месяцы,
        // а npay — чтобы не считать разовыми услуги «Абонентской платы».
        // Обе ручки те же, что в других блоках, поэтому идём через общий кэш панели.
        alive('tariff', Promise.all([
            erpOnce(panel, 'cost', () => ERP.cost(id)),
            erpOnce(panel, 'tariffOptions', () => ERP.tariffOptions(id)),
            feePromise,
            erpOnce(panel, 'npay', () => ERP.npayServices(id).catch(() => [])),
        ]), ([cost, options, fee, npayList]) => {
            const card = panel.querySelector('.tp-lazy[data-lazy="tariff"]');
            if (!card) return;

            const draw = (period) => {
                if (!document.contains(card)) return;
                // bare: тариф встроен в карточку «Абонент и тариф», вторая рамка не нужна
                setHtmlIfChanged(card.querySelector('.tp-lazy-body'),
                    buildTariffHtml(cost, options, ERP.tariff(id), { period, bare: true, npayList }));
                card.classList.add('is-filled');
            };

            // Сначала рисуем без истории за период, потом дополняем — чтобы блок не ждал
            draw(null);
            oneTimeByPeriod(id, fee && fee.perMonth).then((period) => {
                if (period && period.rows.length) draw(period);
            }).catch(() => {});
        });

        alive('trust', Promise.all([balanceOnce(), limitOnce(), feePromise]), ([bal, lim, fee]) => {
            fillLazy(panel, 'trust', buildTrustHtml(bal, lim, {
                outNum, limitNum,
                payback: v.needPay,
                isBlockedByBalance: v.blockedByBalance,
                fee,
                // Статус нужен, чтобы не предлагать платёж закрытому договору:
                // его услуги отключены статусом, а не балансом (BGBilling 43384998).
                status,
                // Режим («Дебет»/«Кредит») берём из параметров договора: в ответе
                // balance.do его нет, поэтому проверка по balance.mode не работала.
                mode: params.mode,
            }));
            mountTrustButton(panel);
            // Абонплата пришла — обновим денежный блок (цена дня и прогноз блокировки)
            if (fee && trustPerDay(fee) > 0) {
                panel._tpFee = fee;
                refreshMoney(panel);
            }
        });

        // Тяжёлые: история статусов и платежи
        alive('status', ERP.statusLog(id), (data) => {
            fillLazy(panel, 'status', renderStatusHistory(data));
        });

        alive('payments', ERP.payments(id), (list) => {
            fillLazy(panel, 'payments', renderPayments(list));
        });

        // «Лимит и задания»: текущее значение, история изменений и запланированные
        // возвраты. Тот же запрос, что нужен доверительному платежу, — поэтому
        // второй раз его не делаем: берём из общего промиса.
        alive('limit', limitOnce(), (data) => {
            fillLazy(panel, 'limit', renderLimit(data, limitNum));
        });

        // Сервисы в биллинге: тип, период, статус и устройство.
        alive('services', servicesOnce(), (data) => {
            fillLazy(panel, 'services', renderServices((data && data.list) || []));
            // Раскрытие истории сервисов переживает перерисовку: автообновление
            // перерисовывает блок каждые 42 секунды, и без восстановления
            // открытый оператором список закрывался бы сам.
            const box = panel.querySelector('.tp-lazy[data-lazy="services"]');
            const more = box && box.querySelector('[data-svc-more]');
            if (more) {
                if (panel._tpSvcMoreOpen) more.open = true;
                more.addEventListener('toggle', () => { panel._tpSvcMoreOpen = more.open; });
            }
        });

        // Примечания — тот же узел, что в дереве карточки BGBilling.
        alive('memo', ERP.memos(id), (list) => {
            panel._tpMemos = list || [];
            fillLazy(panel, 'memo', renderMemoList(panel._tpMemos));
            const count = panel.querySelector('[data-role="memo-count"]');
            if (count) count.textContent = panel._tpMemos.length ? String(panel._tpMemos.length) : '';
            mountMemo(panel);
        });
    }


    /**
     * Баланс за расчётный месяц.
     *
     * В карточке он живёт в узкой колонке рядом с тарифом, а таблица из шести
     * колонок там не помещается: суммы с пробелами-разделителями ломаются на
     * две строки. Поэтому главное (период и исходящий остаток) выносим в шапку,
     * а движение средств — в компактные строки «ключ — значение».
     *
     * Нулевые строки не показываем: «Приход 0.00 · Наработка 0.00 · Расход 0.00»
     * занимают полблока и не несут смысла. Если движений не было вовсе, остаётся
     * только остаток — этого достаточно.
     */
    function buildBalanceHtml(bal) {
        if (!bal) return '<div class="tp-hint">Нет данных по балансу.</div>';

        const isZero = (v) => {
            const n = toNum(v);
            return Number.isFinite(n) && n === 0;
        };
        // «Входящий» и «Исходящий» совпадают, когда за месяц ничего не двигалось.
        // Показывать одно и то же число дважды незачем.
        const sameAsOut = (v) => {
            const a = toNum(v);
            const b = toNum(bal.out);
            return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 0.005;
        };

        const rows = [
            ['Входящий', bal.in, true],
            ['Приход', bal.payment, false],
            ['Наработка', bal.account, false],
            ['Расход', bal.charge, false],
        ].filter(([, v, skipIfSameAsOut]) => {
            if (v == null || String(v).trim() === '') return false;
            if (isZero(v)) return false;
            if (skipIfSameAsOut && sameAsOut(v)) return false;
            return true;
        });

        let html = '<div class="tp-balance">';
        if (bal.month) html += `<div class="tp-balance-month">${esc(bal.month)}</div>`;
        html += `<div class="tp-balance-out">
                <span>Исходящий остаток</span>
                <b>${esc(bal.out || '—')} ₽</b>
            </div>`;
        if (rows.length) {
            html += '<div class="tp-balance-rows">';
            rows.forEach(([k, v]) => {
                html += `<div class="tp-balance-row"><span>${esc(k)}</span><b>${esc(v)}</b></div>`;
            });
            html += '</div>';
        } else {
            html += '<div class="tp-balance-row is-empty"><span>Движений за месяц не было</span></div>';
        }
        return html + '</div>';
    }

    /** Рендер истории статусов — тот же вид, что был при блокирующей загрузке. */
    function renderStatusHistory(data) {
        const hist = (data && data.history ? data.history : []).slice(0, 6);
        if (!hist.length) return '<div class="tp-hint">Изменений статуса нет.</div>';

        let html = '<div class="tp-timeline">';
        hist.forEach((h, i) => {
            const tone = i === 0 ? (/актив/i.test(h.status) ? 'is-ok' : 'is-warn') : '';
            html += `<div class="tp-tl-row ${tone}">
                <span class="tp-tl-dot"></span>
                <div class="tp-tl-body">
                    <div class="tp-tl-head">
                        <span class="tp-tl-status">${esc(h.status)}</span>
                        <span class="tp-tl-period">${esc(h.period)}</span>
                    </div>
                    ${h.comment ? `<div class="tp-tl-comment">${esc(h.comment)}</div>` : ''}
                </div>
            </div>`;
        });
        html += '</div>';

        // Отложенные смены статуса: ERP создаёт их с датой в будущем, и до этого
        // момента договор продолжает жить в текущем статусе. Без этого списка
        // оператор не видел, что договор, например, уже запланирован к закрытию.
        const tasks = (data && data.tasks) || [];
        if (tasks.length) {
            html += '<div class="tp-sect"><div class="tp-sect-head"><span>Запланировано</span></div><div class="tp-balance-rows">';
            tasks.slice(0, 6).forEach((t) => {
                const who = [t.created, t.user].filter(Boolean).join(' · ');
                html += `<div class="tp-balance-row">
                        <span>${esc(t.period || '')}</span>
                        <b>${esc(t.status || '')}${who ? ' · ' + esc(who) : ''}</b>
                    </div>`;
            });
            html += '</div></div>';
        }

        return html;
    }

    /** Рендер платежей. */
    function renderPayments(list) {
        const arr = list || [];
        const lastPay = arr.slice(-8).reverse();
        if (!lastPay.length) return '<div class="tp-hint">Платежей нет.</div>';

        let html = '<table class="tp-table"><tbody>';
        lastPay.forEach((p) => {
            html += `<tr>
                <td class="tp-pay-date">${esc(p.date)}</td>
                <td class="tp-pay-sum">${esc(p.sum)} ₽</td>
                <td class="tp-pay-type">${esc(p.type || '')}</td>
            </tr>`;
        });
        html += '</tbody></table>';

        const total = arr.reduce((s, p) => s + (toNum(p.sum) || 0), 0);
        html += `<div class="tp-hint">Всего за период: ${esc(fmt(total))} ₽ · ${arr.length} шт.</div>`;
        return html;
    }

    /**
     * Имя сервиса для показа оператору.
     *
     * Биллинг формирует имя по шаблону: `<логин> <addrFrom> <addrTo>`.
     * По этому имени видно, выдан ли сервису адрес:
     *   «AV0000001 10.100.31.30 10.100.31.30» — адрес есть (серый или белый);
     *   «AV0000001 [IpAddress:null] [IpAddress:null]» — адреса нет.
     * Второй вариант — не поломка и не «наш баг»: так биллинг печатает
     * заглушку шаблона, пока addrFrom/addrTo пустые. Оператор по этой
     * разнице и определяет, навесился адрес или нет, поэтому признак
     * НЕ выкидываем, а приводим к человеческому виду.
     *
     * Заодно схлопываем повтор адреса: шаблон подставляет его и в addrFrom,
     * и в addrTo, из-за чего адрес приходит дважды и строка становится
     * вдвое длиннее без пользы.
     *
     * dropLogin / dropAddr — для мест, где логин и адрес уже показаны рядом
     * (сессии, «Доступы»): там имя нужно только чтобы отличать сервисы.
     */
    function cleanBillServiceName(raw, opts) {
        const o = opts || {};
        const dropLogin = !!o.dropLogin;
        const dropAddr = !!o.dropAddr;
        const src = String(raw == null ? '' : raw);

        // Адрес из шаблона: берём первый и запоминаем, был ли он вообще.
        // Пустой addrFrom и addrTo приходят как «[IpAddress:null]» — это
        // маркер «адреса нет», а не мусор.
        const addrMatch = src.match(/(\d{1,3}(?:\.\d{1,3}){3})/);
        const addr = addrMatch ? addrMatch[1] : '';

        let text = src.replace(/\[IpAddress:[^\]]*\]/gi, ' ');
        if (dropLogin) text = text.replace(/\b[A-Z]{2,}\d{4,}\b/gi, ' ');
        if (dropAddr) {
            text = text.replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, ' ');
        } else if (addr) {
            // Оставляем адрес один раз: второй экземпляр — тот же addrTo
            text = text.replace(new RegExp(`(\\s*${addr.replace(/\./g, '\\.')}\\s*)+`, 'g'), ` ${addr} `);
        }

        const parts = text.split(/\s+/).filter(Boolean);
        const out = [];
        parts.forEach((p) => {
            if (out.length && out[out.length - 1] === p) return;
            out.push(p);
        });

        const name = out.join(' ').trim();
        // Адреса нет и его не убрали — говорим об этом явно. Пустое место
        // оператор читает как «не догрузилось», а «без адреса» — как факт.
        if (!name) return '';
        if (!addr && !dropAddr) return `${name} · без адреса`;
        return name;
    }

    /**
     * Насколько сервис «живой»: 0 — действует, 1 — закрыт/отключён, 2 — удалён.
     *
     * Один предикат на весь файл. Раньше проверка «сервис ещё работает» была
     * скопирована в шесть мест, и копии успели разойтись: где-то смотрели
     * только status, где-то только state, где-то не учитывали «отключён»
     * и «заблокирован». Из-за этого один и тот же сервис считался живым
     * в одной карточке и мёртвым в соседней.
     *
     * В биллинге status и state — разные поля: status («открыт»/«закрыт») —
     * период действия сервиса, state («включен»/«удален») — его состояние
     * в базе. Удалённый сервис бывает закрыт, но закрытый не всегда удалён,
     * поэтому «удалён» проверяем в обоих полях.
     */
    function svcRank(s) {
        const st = String((s && s.status) || '');
        const se = String((s && s.state) || '');
        if (/удал[её]н/i.test(se) || /удал[её]н/i.test(st)) return 2;
        if (/закрыт|отключ|блокиров/i.test(st)) return 1;
        return 0;
    }

    /** Сервис действует: не закрыт, не отключён, не удалён. */
    const isAliveService = (s) => svcRank(s) === 0;

    /**
     * Список сервисов договора в биллинге.
     *
     * Показываем тип подключения, период и состояние. «Удалён» подсвечиваем:
     * такие записи в дереве выглядят открытыми, но в биллинге их уже нет —
     * именно они ломали создание нового сервиса с тем же логином.
     */
    function renderServices(list) {
        const arr = (list || []).slice();
        if (!arr.length) return '<div class="tp-hint">Сервисов нет.</div>';

        // Действующие показываем всегда, закрытые и удалённые — под раскрытием.
        // На AV0000001 в дереве 28 записей, из них 27 удалённых: если рисовать
        // их подряд, действующий сервис тонет в списке одинаковых «удалён».
        // Но и прятать их совсем нельзя — оператору нужно уметь посмотреть
        // историю (когда закрыт, с каким адресом), поэтому это <details>,
        // а не отброшенные данные.
        const alive = arr.filter((s) => svcRank(s) === 0);
        const dead = arr.filter((s) => svcRank(s) !== 0);

        const rowHtml = (s) => {
            const rank = svcRank(s);
            const stateChip = rank === 2
                ? '<span class="tp-chip is-bad">удалён</span>'
                : rank === 1 ? '<span class="tp-chip is-warn">закрыт</span>'
                    : '<span class="tp-chip is-good">открыт</span>';
            // Имя сервиса и признак адреса.
            //
            // Шаблон биллинга: `<логин> <addrFrom> <addrTo>`. По нему видно,
            // выдан ли адрес: «AV0000001 10.100.31.30» — выдан (серый это или
            // белый — показывает сам адрес), «[IpAddress:null]» — не выдан.
            // Поэтому адрес оставляем, заглушку заменяем на явное «без адреса»,
            // а повтор адреса схлопываем (см. cleanBillServiceName).
            const addrMatch = String(s.name || '').match(/(\d{1,3}(?:\.\d{1,3}){3})/);
            const addr = addrMatch ? addrMatch[1] : '';
            const ipChip = addr
                ? `<span class="tp-chip tp-svc-ip is-xs">${esc(addr)}</span>`
                : '<span class="tp-chip is-warn tp-svc-noip is-xs" title="Сервису не выдан адрес: в имени стоит заглушка шаблона [IpAddress:null]">без адреса</span>';
            return `<div class="tp-pay-row">
                    <span class="tp-pay-name">${esc(cleanBillServiceName(s.name, { dropAddr: true }) || 'Сервис')} ${stateChip}
                        <span class="tp-chip is-xs">${esc(s.type || '')}</span> ${ipChip}
                    </span>
                    <span class="tp-pay-sum">${esc(s.period || '')}</span>
                </div>`;
        };

        let html = '<div class="tp-pay">';
        if (alive.length) {
            alive.forEach((s) => { html += rowHtml(s); });
        } else {
            // Все записи в дереве закрыты: без этой строки блок выглядит пустым
            // и оператор ищет, куда пропал сервис.
            html += '<div class="tp-hint">Действующих сервисов нет — все записи закрыты.</div>';
        }

        if (dead.length) {
            // Раскрытие помнит состояние: автообновление перерисовывает блок
            // каждые 42 секунды, и без этого список схлопывался бы под руками.
            html += `<details class="tp-svc-more" data-svc-more>
                <summary>
                    <span class="tp-svc-more-label">${dead.length === 1 ? 'закрытый сервис' : `ещё ${dead.length} закрытых и удалённых`}</span>
                    <span class="tp-svc-more-hint"></span>
                </summary>
                <div class="tp-svc-more-body">${dead.map(rowHtml).join('')}</div>
            </details>`;
        }

        html += '</div>';
        return html;
    }

    /**
     * Блок «Лимит и задания».
     *
     * Текущее значение — то же, что в шапке карточки. Ниже история изменений
     * (кто и когда понижал лимит) и задания на автоматический возврат: после
     * доверительного платежа BGBilling ставит задание с датой, и оператору
     * важно видеть, что возврат запланирован, а не потерян.
     */
    function renderLimit(data, limitNum) {
        const d = data || {};
        const value = d.limit != null && String(d.limit).trim() !== ''
            ? d.limit
            : (Number.isFinite(limitNum) ? String(limitNum) : '');

        const log = (d.log || []).slice(0, 6);
        const tasks = (d.tasks || []).filter((t) => !isTaskDone(t.status));

        let html = `<div class="tp-balance-out">
                <span>Текущий лимит</span>
                <b>${esc(value || '—')} ₽</b>
            </div>`;

        if (log.length) {
            html += '<div class="tp-sect"><div class="tp-sect-head"><span>История изменений</span></div><div class="tp-balance-rows">';
            log.forEach((r) => {
                const who = [r.user, r.time].filter(Boolean).join(' · ');
                const note = r.comment ? ` title="${esc(r.comment)}"` : '';
                html += `<div class="tp-balance-row"${note}>
                        <span>${esc(who)}</span>
                        <b>${esc(r.limit || '')}${r.days ? ` · ${esc(r.days)} дн.` : ''}</b>
                    </div>`;
            });
            html += '</div></div>';
        }

        if (tasks.length) {
            html += '<div class="tp-sect"><div class="tp-sect-head"><span>Задания на возврат</span></div><div class="tp-balance-rows">';
            tasks.forEach((t) => {
                html += `<div class="tp-balance-row">
                        <span>${esc(t.date || '')}${t.user ? ' · ' + esc(t.user) : ''}</span>
                        <b>${esc(t.change || t.status || '')}</b>
                    </div>`;
            });
            html += '</div></div>';
        } else {
            html += '<div class="tp-hint">Заданий на возврат лимита нет.</div>';
        }

        return html;
    }

    /** HTML карточки «Тариф и скорость» — вынесено из общей сборки для фоновой догрузки. */
    /**
     * Строки «Стоимости» — это и есть то, за что платит абонент
     * (доступ к ИТ-инфраструктуре, абонплата за скорость, публичный IP и т. д.).
     * Приводим их к плоскому списку: название, количество, цена, сумма к оплате.
     */
    function paidItems(cost) {
        const out = [];
        ((cost && cost.groups) || []).forEach((g) => {
            (g.items || []).forEach((i) => {
                const pay = toNum(i.pay);
                const sum = toNum(i.sum);
                out.push({
                    group: g.name,
                    service: i.service,
                    qty: i.qty,
                    price: i.price,
                    pay: Number.isFinite(pay) ? pay : (Number.isFinite(sum) ? sum : 0),
                    included: !(Number.isFinite(pay) ? pay > 0 : Number.isFinite(sum) && sum > 0),
                });
            });
        });
        return out;
    }

    /**
     * Нормализация названия услуги для сравнения тарифа и начислений.
     *
     * ERP пишет одно и то же по-разному:
     *   тариф:      «Бандл · Комбо Микс + START»  > начисления: «Комбо Микс + START»
     *   тариф:      «Доп · Ночной»                > начисления: «Ночной»
     *   тариф:      «Видеонаблюдение: запись 3 дня (300 руб.)» > «Видеонаблюдение: запись 3 дня»
     * Приводим к общему виду: без служебного префикса «Бандл ·» / «Доп ·» / «Пакет ·»,
     * без хвоста «(… руб.)». Без этого ежемесячная «Доп · Ночной» попадала в разовые.
     */
    function normServiceName(raw) {
        return String(raw || '')
            .toLowerCase()
            .replace(/\s*\(\s*[\d\s.,]+\s*руб\.?\s*\)/gi, '')   // цена в скобках у разовых
            // Служебный префикс группы тарифа: «Бандл ·», «Доп ·», «Пакет ·», «Опция ·».
            // Именно группа, а не часть названия — в начислениях её не пишут.
            // Список явный: общее правило «любое слово с точкой» срезало бы
            // «Скорость: 500M» и другие настоящие названия.
            .replace(/^(?:бандл|доп|пакет|опция|услуга)\s*[·.:]\s*/i, '')
            .replace(/[\u00a0]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    /**
     * Название услуги без технических кодов ERP и дублей скорости.
     *
     * В «Стоимости» к имени услуги приклеен её внутренний код:
     *   «Скорость: 150M/150M (SPEED_150MB)» > «Скорость: 150M»
     *   «Абонплата (скорость/интернет)»      — это не код, скобки оставляем
     * Код — латиница в верхнем регистре с подчёркиваниями: SPEED_150MB, IPTV_HD.
     * Русские пояснения в скобках трогать нельзя, они несут смысл.
     *
     * «150M/150M» — это приём/отдача. Оператору достаточно одного числа,
     * поэтому схлопываем одинаковые значения в «150M».
     */
    function cleanServiceName(raw) {
        return String(raw || '')
            .replace(/\s*\(\s*[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\s*\)/g, '')
            .replace(/(\d+(?:[.,]\d+)?\s*[MМ])\s*\/\s*\1/gi, '$1')
            .replace(/\s+/g, ' ')
            .trim();
    }

    /**
     * Разовые услуги из таблицы «Фактически начислено».
     *
     * Разовая — та, которой нет ни в составе тарифа, ни в «Абонентской плате».
     * Оба источника — это ежемесячные позиции:
     *   • состав тарифа — таблица «Стоимость» > «Тариф»;
     *   • абонплата — модуль Npay («Публичный IP-адрес», «Аренда роутера»…),
     *     её в составе тарифа нет, поэтому раньше она попадала в разовые.
     * Наличие цены в скобках — дополнительный признак, но сам по себе не решает:
     * у разовых она бывает, у тарифных — нет.
     *
     * Одноимённые разовые НЕ склеиваем: «Инсталляционные работы (3500 руб.)»
     * и «(1000 руб.)» — разные услуги, а после среза цены имена совпадают.
     * Поэтому строки идут по одной, а не сливаются в одну сумму.
     * Возвращает [{ service, months: { '2026-10': 4500 }, total }].
     */
    function oneTimeItems(cost, npayList) {
        const charged = (cost && cost.charged) || { months: [], items: [] };
        const tariffNames = new Set(
            ((cost && cost.groups) || [])
                .flatMap((g) => (g.items || []).map((i) => normServiceName(i.service)))
                .filter(Boolean)
        );
        // Услуги абонплаты — тоже ежемесячные, вычитаем их так же, как тарифные
        const npayNames = new Set(
            (npayList || []).map((s) => normServiceName(s.name)).filter(Boolean)
        );

        const out = [];
        (charged.items || []).forEach((row) => {
            const name = String(row.service || '').trim();
            if (!name) return;

            const key = normServiceName(name);
            // Есть в тарифе или в абонплате — это ежемесячная позиция, не разовая
            if (tariffNames.has(key) || npayNames.has(key)) return;

            const months = {};
            let total = 0;
            (row.byMonth || []).forEach((v, idx) => {
                const n = toNum(v);
                const key2 = charged.months[idx] || String(idx);
                if (Number.isFinite(n) && n !== 0) {
                    months[key2] = n;
                    total += n;
                }
            });
            if (!total) return;

            out.push({ service: name, months, total });
        });

        return { months: charged.months || [], items: out, total: out.reduce((s, i) => s + i.total, 0) };
    }

    /**
     * Разовые начисления за весь период договора по месяцам.
     * balance.do отдаёт «Наработка» за каждый месяц — это все начисления.
     * Тариф известен из «Итого в месяц», поэтому разово = наработка − тариф.
     */
    async function oneTimeByPeriod(contractId, monthlyFeeValue) {
        try {
            const html = await fetchText(
                `/user/plugin/bgbilling/proto/balance.do?billingId=bill&contractId=${contractId}` +
                `&method=balance&dateFrom=01.01.2000&dateTo=${encodeURIComponent(todayRu())}`
            );
            const body = parseHtml(html);
            const rows = [];

            body.querySelectorAll('table.data tr').forEach((tr) => {
                const tds = Array.from(tr.querySelectorAll('td'));
                if (tds.length < 6) return;
                const month = tds[0].innerText.replace(/\s+/g, ' ').trim();
                if (!/\d{4}/.test(month) || /месяц|год/i.test(month)) return;

                const charge = toNum(tds[3].innerText);  // Наработка — все начисления месяца
                if (!Number.isFinite(charge)) return;

                const fee = Number(monthlyFeeValue) || 0;
                const extra = fee > 0 ? Number((charge - fee).toFixed(2)) : 0;
                rows.push({ month, charge, extra: extra > 0 ? extra : 0 });
            });

            const total = rows.reduce((s, r) => s + r.extra, 0);
            return { rows, total: Number(total.toFixed(2)) };
        } catch (e) {
            return { rows: [], total: 0 };
        }
    }

    /**
     * HTML блока «Тариф и скорость»: тариф, цена, скорость и за что платит абонент.
     * Технические подключения здесь не показываем — они в блоке «Сессия».
     *
     * ctx.bare = true — рисовать без обёртки .tp-card. Нужно, когда тариф
     * встраивается внутрь карточки «Абонент и тариф»: вторая рамка внутри
     * первой выглядела бы как вложенная карточка.
     */
    function buildTariffHtml(cost, options, tariff, ctx) {
        const planName = (((tariff && tariff.plans) || [])[0] || '').replace(/\s*\(.*\)\s*$/, '');
        const payTotal = ((cost && cost.total && cost.total.pay) || '').replace(/[^\d.,-]/g, '');
        const payPrice = ((cost && cost.total && cost.total.price) || '').replace(/[^\d.,-]/g, '');
        const items = paidItems(cost);
        const bare = !!(ctx && ctx.bare);

        // Закрывающий </div> в конце функции общий для обоих вариантов.
        // bare: тариф встроен в карточку абонента, где заголовок секции
        // «Тариф и скорость» уже нарисован снаружи — иначе он задваивался.
        let html = bare
            ? '<div class="tp-tariff">'
            : '<div class="tp-card"><div class="tp-card-title"><span class="tp-dot"></span>Тариф и скорость</div>';

        // Шапка: только название тарифа. Скорость отдельным бейджем не дублируем —
        // она и так есть в строке «Скорость: 500M» в разделе «За что платит».
        html += '<div class="tp-tariff-head">';
        html += `<div class="tp-plan">${esc(planName || '—')}</div>`;
        html += '</div>';

        if (payTotal) {
            html += `<div class="tp-price">
                <span class="tp-main">${esc(payTotal)} ₽</span>
                ${payPrice && payPrice !== payTotal ? `<span class="tp-old">${esc(payPrice)} ₽</span>` : ''}
                <span class="tp-per">в месяц</span>
            </div>`;
        }

        // Скидки и опции тарифа
        if ((options || []).length) {
            html += '<div class="tp-chips">';
            options.forEach((o) => {
                html += `<span class="tp-chip">${esc(o.name)}${o.from ? ' · с ' + esc(o.from.split(' ')[0]) : ''}</span>`;
            });
            html += '</div>';
        }

        // Расхождения заголовка тарифа («(681 руб/мес)») и итога не показываем:
        // это особенность отображения ERP, для расчётов берётся «Итого в месяц».

        // ---- ГЛАВНОЕ: за что платит абонент
        html += `<div class="tp-sect">
            <div class="tp-sect-head">
                <span>За что платит</span>
                <span class="tp-sect-count">${items.length ? items.length + ' поз.' : 'нет начислений'}</span>
            </div>`;

        if (!items.length) {
            html += '<div class="tp-hint" style="padding:6px 0">Начислений нет.</div>';
        } else {
            html += '<div class="tp-pay">';
            items.forEach((i) => {
                html += `<div class="tp-pay-row${i.included ? ' is-free' : ''}">
                    <span class="tp-pay-name">${esc(cleanServiceName(i.service))}${Number(i.qty) > 1 ? ` <span class="tp-chip is-xs">×${esc(i.qty)}</span>` : ''}</span>
                    <span class="tp-pay-sum">${i.included ? 'включено' : esc(fmt(i.pay)) + ' ₽'}</span>
                </div>`;
            });
            html += '</div>';
        }
        html += '</div>';

        // ---- Разовые услуги: названия за 2 месяца (столько отдаёт ERP) + сумма за весь период
        const oneTime = oneTimeItems(cost, ctx && ctx.npayList);
        const period = ctx && ctx.period ? ctx.period : null;
        if (oneTime.items.length || (period && period.total > 0)) {
            html += `<div class="tp-sect">
                <div class="tp-sect-head">
                    <span>Разовые услуги</span>
                    <span class="tp-sect-count">${oneTime.items.length
                        ? esc(fmt(oneTime.total)) + ' ₽'
                        : (period ? esc(fmt(period.total)) + ' ₽ за период' : '')}</span>
                </div>`;

            if (oneTime.items.length) {
                // Одноимённые разовые различаем по отображаемому имени, а не по
                // нормализованному: «Инсталляционные работы (3500 руб.)» и
                // «(1000 руб.)» в интерфейсе и так разные — цены в скобках хватает.
                // Дополнительная пометка нужна только если имена совпали полностью.
                const shown = new Map();
                oneTime.items.forEach((i) => {
                    const label = cleanServiceName(i.service);
                    shown.set(label, (shown.get(label) || 0) + 1);
                });
                html += '<div class="tp-pay">';
                oneTime.items.forEach((i) => {
                    const when = Object.keys(i.months).join(', ');
                    const base = cleanServiceName(i.service);
                    // Совпали имена — показываем сумму в названии, иначе строки не отличить
                    const ambiguous = (shown.get(base) || 0) > 1;
                    const label = ambiguous ? `${base} · ${fmt(i.total)} ₽` : base;
                    html += `<div class="tp-pay-row">
                        <span class="tp-pay-name">${esc(label)}${when ? ` <span class="tp-chip is-xs">${esc(when)}</span>` : ''}</span>
                        <span class="tp-pay-sum">${esc(fmt(i.total))} ₽</span>
                    </div>`;
                });
                html += '</div>';
            } else {
                html += '<div class="tp-hint" style="padding:2px 0 6px">За последние месяцы разовых не было.</div>';
            }

            // Итог за весь период по данным наработки (названия по старым месяцам ERP не отдаёт)
            // Итог за весь период по данным наработки (названия по старым месяцам ERP не отдаёт).
            // Суммы не совпадают с верхней строкой по двум причинам, и это нормально:
            //   • верхняя — только за 2 месяца, которые отдаёт ERP;
            //   • здесь — вся наработка сверх абонплаты, включая прошлые месяцы,
            //     поэтому возможна и разница из-за смены тарифа внутри месяца.
            if (period && period.rows.length) {
                const extraMonths = period.rows.filter((r) => r.extra > 0);
                html += `<div class="tp-period-total">
                    <span>За весь период договора</span>
                    <b>${esc(fmt(period.total))} ₽</b>
                </div>`;
                if (extraMonths.length) {
                    html += '<div class="tp-hint" style="padding-top:2px">'
                        + extraMonths.map((r) => `${esc(r.month)}: ${esc(fmt(r.extra))} ₽`).join(' · ')
                        + '</div>';
                }
                if (oneTime.items.length && Number.isFinite(period.total)
                    && Math.abs(period.total - oneTime.total) >= 1) {
                    html += '<div class="tp-hint" style="padding-top:2px">'
                        + 'Разница с суммой выше: там только последние месяцы, здесь — весь период.'
                        + '</div>';
                }
            }
            html += '</div>';
        }

        html += '</div>';
        return html;
    }

    /** Разбор даты ERP «29.10.2026 15:51:22» > Date. Пустая/битая — null. */
    function parseErpDate(s) {
        const m = String(s || '').match(/(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?/);
        if (!m) return null;
        const d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]),
            Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0));
        return Number.isNaN(d.getTime()) ? null : d;
    }

    /**
     * Задание на смену лимита уже отработало.
     *
     * В таблице заданий ERP статус приходит как «off» у выполненного задания
     * и «on»/«активная» у действующего. Проверять только по словам
     * «отмен/выполн» нельзя: «off» под это не подходит, и задание, которое
     * сервер уже применил в 00:00, продолжало считаться действующим —
     * доверительный платёж блокировался навсегда.
     */
    const isTaskDone = (status) => {
        const s = String(status || '').trim();
        if (!s) return false;
        if (/^(off|done|expired|выполнена?|отменена?)$/i.test(s)) return true;
        if (/^(on|active|активн)/i.test(s)) return false;
        return /отмен|выполн|expired|done/i.test(s);
    };

    /**
     * Можно ли сейчас выдать обещанный платёж.
     *
     * Как это устроено в оригинале (проверено на живом биллинге 03.11.2026):
     *
     *   • Отдельной кнопки «Обещанный платёж» в ERP НЕТ. Есть форма на вкладке
     *     «Лимит»: [Сумма] / [Дней] [Комментарий] [Изменить]. Обещанный платёж —
     *     это та же форма с ОТРИЦАТЕЛЬНОЙ суммой; сервер сам считает
     *     «долг + абонплата × дни» и ставит задачу на возврат.
     *   • ERP не проверяет ни кулдаун, ни статус, ни текущий минус в лимите.
     *     Форма доступна всегда, а решение принимает биллинг.
     *   • Биллинг тоже не блокирует повтор: на договоре 3 платёж давали
     *     29.10.2026, а 03.11.2026 повторный на −100 ₽ прошёл успешно и создал
     *     новую задачу возврата на 06.11.2026. Никакого «раза в 30 дней» нет —
     *     это было домыслом прежней версии скрипта.
     *   • Ограничение по правам есть, но одностороннее: понижение лимита
     *     разрешено, повышение — запрещено («Действие ... Изменение лимита
     *     запрещено»). Поэтому вернуть лимит вручную оператор не может, это
     *     делает задача по сроку.
     *
     * Вывод: любые наши запреты только мешают. Оператор видит кнопку всегда,
     * а если биллинг откажет — показываем его ответ как есть.
     *
     * Оставляем ровно две проверки, и обе про смысл, а не про правила:
     *   • нечего вносить (сумма 0) — платить нечего;
     *   • договор закрыт или приостановлен — статус отключает услуги, лимит
     *     тут ни при чём (BGBilling 43384998).
     *
     * Возвращает { allowed, reason } — reason показываем оператору как есть.
     */
    function trustEligibility(limitData, balance, days, amount, mode) {
        const d = limitData || {};

        // Почему сумма нулевая — две разные ситуации, и путать их нельзя.
        //
        // На 37832 лимит после платежа был −0.05 ₽ «на округление», и прежняя
        // версия считала это действующим понижением, хотя в лимите лежала
        // копейка. Оператор видел неактивную кнопку и причину «уже действует
        // временный лимит», хотя платить было можно и нужно. Отрицательный
        // лимит — подсказка для подписи, а не запрет.
        //
        // Флаг nothing отделяет «вносить нечего» от «нельзя»: это не ошибка,
        // и подсвечивать его красным вместе с запретами неправильно.
        if (!(amount > 0)) {
            const cur = toNum(d.limit);
            const pend = (d.tasks || []).find((t) => !isTaskDone(t.status));
            if (Number.isFinite(cur) && cur < 0) {
                return {
                    allowed: false,
                    nothing: true,
                    reason: `Понижение ${fmt(cur)} ₽ уже действует`
                        + (pend && pend.date ? `, возврат ${pend.date}` : '')
                        + ' — запаса хватает на весь срок',
                };
            }
            return { allowed: false, nothing: true, reason: 'Вносить нечего — долга нет' };
        }

        // Понижение доступно только дебетовым договорам: в кредитном режиме
        // лимита нет вовсе, и форма «Лимит» в ERP не показывается.
        //
        // Режим приходит из параметров договора (ctx.mode), а не из balance.mode.
        // В ответе balance.do поля mode нет вообще, поэтому прежняя проверка
        // `balance.mode` не срабатывала никогда: кредитный договор получал
        // активную кнопку и падал уже на ответе биллинга. balance.mode оставлен
        // запасным вариантом — на случай, если ручка начнёт его отдавать.
        const modeText = String(mode || (balance && balance.mode) || '');
        if (modeText && !/дебет/i.test(modeText)) {
            return { allowed: false, reason: 'Договор не в режиме «Дебет» — управление лимитом недоступно' };
        }

        // Действующее понижение не блокирует новый платёж (см. выше), но о нём
        // полезно предупредить: сумма ляжет поверх текущего минуса.
        const curLimit = toNum(d.limit);
        if (Number.isFinite(curLimit) && curLimit < 0) {
            const tasks = d.tasks || [];
            const pend = tasks.find((t) => !isTaskDone(t.status));
            return {
                allowed: true,
                note: `Сейчас действует понижение ${fmt(curLimit)} ₽`
                    + (pend && pend.date ? ` — возврат ${pend.date}` : ''),
            };
        }

        return { allowed: true, reason: '' };
    }

    /** HTML карточки «Доверительный платёж». */
    function buildTrustHtml(balance, limitData, ctx) {
        const outNum = (balance && balance.out != null) ? toNum(balance.out) : ctx.outNum;
        // Пустая строка от ERP — это «нет данных», а не лимит 0
        const rawLimit = limitData && limitData.limit;
        const parsedLimit = (rawLimit == null || String(rawLimit).trim() === '') ? NaN : toNum(rawLimit);
        const limitNum = Number.isFinite(parsedLimit) ? parsedLimit : ctx.limitNum;
        const fee = (ctx && ctx.fee) || null;
        const perDay = trustPerDay(fee);
        const autoAmount = trustAmount(outNum, limitNum, DEFAULT_DAYS, fee);

        // Вердикт («вносить не нужно» / «заблокирован») уже показан в денежном блоке
        // выше. Здесь — только расчёт суммы, без повторения того же вывода словами.
        // Строка нужна, когда платёж не поможет: неактивный статус договора
        // отключает услуги, и лимит тут ни при чём (BGBilling 43384998).
        //
        // Статус разбираем так же, как в connectionVerdict: активным считаем
        // только тот, что начинается с «Актив». «Заморозка», «Приостановлен»,
        // «В отключении» и прочие статусы из contract.status.list — все
        // неактивные, и деньги их не снимают.
        const statusText = String((ctx && ctx.status) || '').trim();
        const statusActive = !statusText || /^актив/i.test(statusText);
        const isClosed = !statusActive && /закрыт|удал|отключ/i.test(statusText);
        const isSuspended = !statusActive && !isClosed;

        // Правила: как в оригинале — платить можно всегда, когда есть что вносить.
        // Закрытый договор не блокируем: оператор видит предупреждение, но решает
        // сам. Биллинг всё равно откажет, если операция запрещена.
        const elig = trustEligibility(limitData, balance, DEFAULT_DAYS, autoAmount,
            (ctx && ctx.mode) || '');

        // Кнопка активна, когда есть что вносить и режим позволяет управлять лимитом.
        // Статус договора и кулдаун не блокируют: в оригинале их нет.
        //
        // canPay считается ДО подписи и подпись выводится строго из него. Раньше
        // она строилась по своим условиям (isClosed/isSuspended), из-за чего
        // расходилась с состоянием кнопки: закрытый договор с долгом показывал
        // «Платёж не поможет», хотя в оригинальном ERP форма «Лимит» доступна,
        // а договор 37832 с активным статусом и долгом 0 — «Вносить не нужно»
        // рядом с активной кнопкой.
        const canPay = autoAmount > 0 && elig.allowed;

        const warn = isClosed
            ? 'Договор закрыт — услуги отключены статусом, платёж доступ не вернёт.'
            : isSuspended
                ? `Статус «${statusText}» — услуги на паузе по статусу договора, `
                    + 'а не по балансу. Платёж доступ не вернёт: статус ставит администратор.'
                : (!Number.isFinite(outNum) || !Number.isFinite(limitNum))
                    ? 'Не удалось прочитать остаток или лимит — проверьте вкладку «Лимит» вручную.'
                    : (!elig.allowed ? elig.reason + '.' : (elig.note ? elig.note + '.' : ''));

        // Сумма и комментарий — не поля, а подпись: их всё равно считает биллинг,
        // а оператору важно только число дней. Раньше три поля занимали три строки
        // и дублировали кнопку «Обещанный платёж» из вкладки «Лимит».
        //
        // Расчёт показываем только когда платёж реально нужен: иначе получалось
        // «Долг 0.00 ₽ + 3 дн. 116.42 ₽ = 0.00 ₽» — три числа, противоречащих
        // кнопке «Вносить не нужно».
        const calcHtml = canPay
            ? `<div class="tp-trust-calc">
                Долг ${esc(fmt(Math.max(0, limitNum - outNum)))} ₽ + ${DEFAULT_DAYS} дн.
                ${esc(fmt(perDay * DEFAULT_DAYS))} ₽ = <b>${esc(fmt(autoAmount))} ₽</b>
            </div>`
            : '';

        // Текст кнопки повторяет ровно то, что произойдёт при нажатии. Три
        // состояния, и каждое следует из canPay, а не из отдельных догадок:
        //   • можно платить — называем срок, который уйдёт в period;
        //   • нельзя, но деньги есть — «Недоступно сейчас» + причина в подписи;
        //   • вносить нечего — «Вносить не нужно».
        const btnLabel = canPay
            ? `Обещанный платёж на ${DEFAULT_DAYS} дн.`
            : autoAmount > 0 ? 'Недоступно сейчас' : 'Вносить не нужно';

        // Предупреждение — жёлтым, когда это не блокировка, а совет.
        // «Вносить нечего» — не ошибка: красным подсвечиваем только настоящие
        // запреты (режим, статус, нечитаемые данные), иначе спокойный договор
        // выглядел как авария.
        const warnCls = (isClosed || isSuspended || (!elig.allowed && !elig.nothing)) ? 'is-bad' : 'is-warn';

        return `<div class="tp-trust-inner">
            ${warn ? `<p class="tp-trust-lead ${warnCls}">${warn}</p>` : ''}
            <div class="tp-trust-row">
                <label class="tp-field tp-trust-days">Дней
                    <input type="text" class="tp-days" value="${DEFAULT_DAYS}">
                </label>
                <button type="button" class="tp-btn tp-apply"${canPay ? '' : ' disabled'}>${esc(btnLabel)}</button>
            </div>
            ${calcHtml}
            <span class="tp-msg"></span>
        </div>`;
    }

    function mountTrustButton(panel) {
        const btn = panel.querySelector('.tp-apply');
        if (!btn || btn.dataset.bound === '1') return;
        btn.dataset.bound = '1';

        // Пересчёт живёт прямо в подписи «Долг + N дн. = сумма»: отдельная кнопка
        // «Пересчитать» была не нужна — при нажатии основной кнопки всё равно
        // пересчитывается заново (остаток и лимит могли измениться).

        btn.addEventListener('click', async () => {
            const id = panel.dataset.contractId || ERP.contractId(panel.closest('#content > div[id^="contract_bill-"]'));
            const days = panel.querySelector('.tp-days').value.trim();
            const comment = DEFAULT_COMMENT;
            const msg = panel.querySelector('.tp-msg');
            const original = btn.textContent;

            if (!id) { msg.textContent = 'Нет ID договора'; return; }
            if (!/^\d+$/.test(days) || Number(days) < 1) { msg.textContent = 'Дней — целое число не меньше 1'; return; }

            btn.disabled = true;
            msg.className = 'tp-msg';
            msg.textContent = 'Считаю и отправляю…';

            try {
                // Пересчёт «на лету»: остаток и лимит могли измениться после отрисовки карточки
                const [bal, lim, fee] = await Promise.all([
                    ERP.balance(id), ERP.limitInfo(id), feeProfile(id),
                ]);
                const out = (bal && bal.out != null) ? toNum(bal.out) : NaN;
                const limit = (lim && lim.limit != null && String(lim.limit).trim() !== '') ? toNum(lim.limit) : NaN;
                const daysNum = Number(days);

                if (!Number.isFinite(limit)) throw new Error('Не удалось получить лимит');
                if (!Number.isFinite(out)) throw new Error('Не удалось получить остаток');

                const sum = trustAmount(out, limit, daysNum, fee);

                if (!sum) {
                    msg.className = 'tp-msg is-ok';
                    // Ноль теперь значит «вносить нечего», и причин ровно две:
                    // запас уже покрывает запрошенный срок или абонплата не
                    // определилась. Раньше сюда попадал и случай, когда абонент
                    // был внутри выданного лимита с запасом на полдня, — и
                    // оператор читал «Платёж не нужен» при живом риске блокировки.
                    msg.textContent = `Вносить нечего: остаток ${fmt(out)} ₽, лимит ${fmt(limit)} ₽ — `
                        + `запаса хватает на ${daysNum} дн. или абонплата не определилась.`;
                    btn.disabled = false;
                    return;
                }

                // Проверяем ещё раз — за время работы карточки режим договора мог
                // измениться из другого окна. Кулдауна и статуса здесь нет:
                // в оригинале их тоже нет, решает биллинг.
                const elig = trustEligibility(lim, bal, daysNum, sum,
                    (panel._tpCtx && panel._tpCtx.mode) || '');
                if (!elig.allowed) {
                    msg.className = 'tp-msg is-bad';
                    msg.textContent = elig.reason + '.';
                    btn.disabled = false;
                    return;
                }

                const newLimit = limit - sum;
                const perDay = trustPerDay(fee);
                // Дневная норма всегда считается как месячная / 30 — так же,
                // как в оригинальном ERP. Раньше здесь был выбор между
                // «по фактическим списаниям» и «N дн.» по календарю, но норма
                // от длины месяца больше не зависит.
                const feeLine = perDay > 0
                    ? `${fmt(fee.perMonth || 0)} ₽/мес (≈${fmt(perDay)} ₽/день, 30 дн.)`
                    : 'не определена';
                const ok = window.confirm(
                    `Доверительный платёж на ${daysNum} дн.\n\n` +
                    `Остаток: ${fmt(out)} ?\n` +
                    `Лимит: ${fmt(limit)} → ${fmt(newLimit)} ?\n` +
                    `Абонплата: ${feeLine}\n\n` +
                    'Понизить лимит?'
                );
                if (!ok) {
                    msg.className = 'tp-msg';
                    msg.textContent = 'Отменено.';
                    btn.disabled = false;
                    return;
                }

                btn.textContent = 'Отправка…';
                // updateLimit(contractId, value, period, comment):
                // value < 0 — понижение, period > 0 — BGBilling создаст задание на возврат лимита
                const resp = await postForm('/user/plugin/bgbilling/proto/contract.do', {
                    method: 'updateLimit',
                    contractId: id,
                    billingId: 'bill',
                    value: '-' + sum,
                    period: String(daysNum),
                    comment,
                });
                if (!resp || /Exception|error|minlimit|mindays|maxdays|minsumm|maxsumm/i.test(resp.slice(0, 400))) {
                    msg.className = 'tp-msg is-bad';
                    msg.textContent = 'Ошибка биллинга: ' + String(resp).slice(0, 200);
                } else {
                    msg.className = 'tp-msg is-ok';
                    msg.textContent = `Лимит ${fmt(limit)} > ${fmt(newLimit)} ₽ на ${daysNum} дн. ` +
                        'Услуги откроются в течение ~15 минут (проверка шлюзов IPN).';
                    setTimeout(() => applyContent(panel, contentBuilder), 900);
                }
            } catch (e) {
                msg.className = 'tp-msg is-bad';
                msg.textContent = 'Ошибка: ' + (e.message || e);
            } finally {
                btn.disabled = false;
                btn.textContent = original;
            }
        });
    }

    function applyContent(panel, html) {
        if (!panel) return;

        // Новое поколение — своё у каждой панели.
        // Глобальный счётчик гасил ответы всех панелей, кроме последней перерисованной.
        const generation = String((Number(panel.dataset.gen) || 0) + 1);
        panel.dataset.gen = generation;

        // Перерисовка начинается заново: гасим прежний опрос и сбрасываем
        // «однократные» кэши блоков, иначе новый каркас получил бы старые данные.
        stopAutoRefresh(panel);
        panel._tpOnce = null;
        panel._tpLogCache = null;
        panel._tpPwdCache = null;
        panel._tpErrHtml = null;
        panel._tpAccessHtml = null;
        // Разбор #treeTable тоже обнуляем: договор мог смениться, а кэш
        // от прошлой отрисовки содержал бы прежние статус и баланс.
        panel._tpParams = null;
        // Раскрытие истории сервисов — тоже: у нового договора свой список,
        // и открывать его за оператора незачем.
        panel._tpSvcMoreOpen = false;

        panel.innerHTML = '<div class="tp-loading">Загрузка данных договора…</div>'
            + '<div class="tp-body"></div>';

        const body = panel.querySelector('.tp-body');
        const loading = panel.querySelector('.tp-loading');

        const promise = Promise.resolve()
            .then(() => (typeof html === 'function' ? html(panel) : html || ''))
            .then((result) => {
                if (panel.dataset.gen !== generation) return; // панель уже перерисована заново
                if (!document.contains(panel)) return;
                if (loading) loading.remove();
                body.innerHTML = typeof result === 'string' ? result : '';
                panel.dataset.contractId = ERP.contractId(panel.closest('#content > div[id^="contract_bill-"]'));
                // Отметка «когда панель собрана»: по ней bindRefresh решает,
                // нужно ли перерисовывать при возврате на вкладку.
                panel._tpRenderedAt = Date.now();
                mountTrustButton(panel);
                mountPasswords(panel);
                hydrate(panel).catch(() => { /* блоки просто останутся скелетонами */ });
                body.dispatchEvent(new CustomEvent('tp-info:rendered', { bubbles: true }));
            })
            .catch((e) => {
                if (panel.dataset.gen !== generation || !loading) return;
                loading.textContent = 'Ошибка построения содержимого: ' + (e && e.message ? e.message : e);
                // var(), а не #c00: на тёмном фоне тёмно-красный давал
                // контраст ~1.9:1, и сообщение об ошибке было не видно.
                loading.style.color = 'var(--tp-bad)';
            });

        return promise;
    }

    function setContent(html) {
        const panels = Array.from(document.querySelectorAll(PANEL_SEL));
        panels.forEach((panel) => applyContent(panel, html));
        contentBuilder = () => html;
    }

    function install() {
        if (typeof window.jQuery === 'undefined' || !window.jQuery.fn || !window.jQuery.fn.tabs) return false;

        const $ = window.jQuery;

        /*
         * Вкладку добавляем в каждую карточку договора отдельно:
         * ERP держит их в #content > div#contract_bill-N и переключает display.
         * Панель ищем по префиксу id — у каждого договора своя.
         */
        let added = false;

        $('.ui-tabs').each(function () {
            const $box = $(this);

            // Только главные вкладки карточки договора (не вложенные модули)
            const hrefs = $box.find('> .ui-tabs-nav > li > .ui-tabs-anchor').map(function () {
                const href = $(this).attr('href') || '';
                return href.startsWith('#') ? href.slice(1) : '';
            }).get();
            const labels = $box.find('> .ui-tabs-nav > li > .ui-tabs-anchor').map(function () {
                return normLabel($(this).text());
            }).get();

            const isMain = hrefs.includes('params') || hrefs.includes('reports')
                || labels.some((l) => l === 'карточки' || l === 'стоимость')
                || $box.find('#treeTable').length > 0;

            if (!isMain) return;

            const hostDiv = this.closest('#content > div[id^="contract_bill-"]');
            // Карточка снова стала видимой (ERP прячет через display) — разрешаем
            // автопереключение на «Для ТП» ещё раз при входе в договор.
            resetTpAutoShownIfReopened(hostDiv, $box);

            const panel = $box.find('> [id^="' + PANEL_ID_BASE + '-"]').get(0);
            const navLink = $box.find('> .ui-tabs-nav > li > a[href^="#' + PANEL_ID_BASE + '-"]').get(0);

            // Вкладка уже есть — всё равно пробуем активировать (один раз на показ)
            if (panel && navLink) {
                try { activateTpTab($box, panel); } catch (e) { /* старый jQuery UI */ }
                return;
            }

            try {
                ensureTabsInit($box);

                // ID договора именно этой карточки, а не текущего URL
                const contractId = ERP.contractId(hostDiv);
                const pid = panelIdFor(contractId || 'x');

                // Панель могла остаться от прошлой отрисовки без вкладки — используем её
                let target = panel;
                if (!target) {
                    target = document.createElement('div');
                    const firstPanel = $box.find('> .ui-tabs-panel').get(0);
                    const holder = firstPanel ? firstPanel.parentNode : this;
                    holder.appendChild(target);
                }

                target.id = (panel && panel.id) || $box.data('tpPanelId') || pid;
                target.className = 'ui-tabs-panel ui-corner-bottom ui-widget-content';
                target.setAttribute('role', 'tabpanel');
                target.setAttribute('aria-hidden', 'true');
                // Прячем ДО добавления вкладки: иначе jQuery UI успевает её
                // активировать, и панель мелькает на секунду при открытии договора.
                target.style.display = 'none';

                $box.data('tpPanelId', target.id);

                if (!navLink) {
                    const activeBefore = $box.tabs('option', 'active');
                    $box.tabs('add', '#' + target.id, TAB_TITLE);
                    // Возвращаем активную вкладку на прежнюю — наша только добавлена
                    if (typeof activeBefore === 'number' && activeBefore >= 0) {
                        try { $box.tabs('option', 'active', activeBefore); } catch (e) { /* старый jQuery UI */ }
                    }
                    target.style.display = 'none';
                }

                // ERP рисует кнопку обновления только у вкладок с URL. Наша панель
                // вставлена вручную, поэтому ставим такую же кнопку сами — теми же
                // классами, чтобы она выглядела и вела себя как у соседних вкладок.
                mountTabRefresh($box, target);

                bindRefresh($box);

                if (target.dataset.contractId !== contractId) {
                    target.dataset.contractId = contractId;
                    applyContent(target, contentBuilder);
                }

                // Договор открыли — переключаемся на «Для ТП».
                // jQuery UI Tabs (1.12, как в BGERP): option active — индекс панели,
                // по умолчанию 0 («Параметры»). После tabs('add') ставим наш индекс.
                try { activateTpTab($box, target); } catch (e) { /* старый jQuery UI */ }

                added = true;
            } catch (e) {
                // попробуем на следующем тике
            }
        });

        /*
         * «Установлено» = на странице уже есть хотя бы одна наша панель.
         *
         * Раньше функция возвращала false всегда, и сторож честно считал, что
         * вкладку поставить не удалось: каждые 150 мс он заново проходил по
         * всем .ui-tabs, пересчитывал подписи, проверял автоактивацию. На
         * открытом договоре это был вечный цикл по 6–7 раз в секунду, хотя
         * делать уже нечего.
         */
        return added || document.querySelector(PANEL_SEL) !== null;
    }

    /** Текст вкладки без пробелов и nbsp — чтобы сравнение не ломалось на разметке ERP. */
    function normLabel(text) {
        return String(text || '').replace(/\s|\u00a0/g, '').toLowerCase();
    }

    /**
     * ERP прячет карточки через display:none и показывает снова при возврате.
     * Сбрасываем флаг авто-вкладки, чтобы при повторном входе снова открыть «Для ТП».
     */
    function resetTpAutoShownIfReopened(hostDiv, $tabs) {
        if (!hostDiv || !$tabs || !$tabs.length) return;
        const hidden = getComputedStyle(hostDiv).display === 'none';
        const wasHidden = $tabs.data('tpWasHidden');
        $tabs.data('tpWasHidden', hidden);
        // Первый проход (wasHidden === undefined): не сбрасываем — активируем как обычно
        if (wasHidden === true && !hidden) {
            $tabs.removeData('tpAutoShown');
        }
    }

    /**
     * Делает «Для ТП» активной вкладкой карточки договора.
     *
     * jQuery UI Tabs (BGERP 3.x, jquery-ui 1.12): option active — индекс панели,
     * по умолчанию 0 (первая вкладка ERP). После tabs('add') надо явно
     * переставить active на нашу панель, иначе откроются «Параметры».
     *
     * Один раз на показ карточки (data-tpAutoShown): иначе автоопрос install()
     * не даст оператору перейти на другую вкладку. При повторном открытии
     * карточки флаг сбрасывает resetTpAutoShownIfReopened.
     */
    function activateTpTab($tabs, panel) {
        if (!panel || !$tabs || !$tabs.length) return false;
        const $ = window.jQuery;
        if (!$ || !$.fn || !$.fn.tabs) return false;

        const key = 'tpAutoShown';
        if ($tabs.data(key)) return false;

        const $panel = $(panel);
        if (!$panel.closest($tabs).length) return false;

        // Индекс панели среди панелей этого контейнера
        const index = $tabs.find('> .ui-tabs-panel').index($panel);
        if (index < 0) return false;

        // Помечаем ДО переключения, чтобы tabsactivate не вызвал нас повторно
        $tabs.data(key, panel.id);

        $panel.css('display', '');
        $panel.removeAttr('aria-hidden');
        try { $tabs.tabs('option', 'active', index); } catch (e) { /* старый jQuery UI */ }

        // Страховка для версий, где option('active') не срабатывает на вновь добавленной панели
        const $li = $tabs.find('> .ui-tabs-nav > li').filter((i, el) => {
            const a = el.querySelector('a');
            return a && (a.getAttribute('href') || '') === '#' + panel.id;
        });
        if ($li.length) {
            $tabs.find('> .ui-tabs-nav > li').removeClass('ui-tabs-active ui-state-active');
            $li.addClass('ui-tabs-active ui-state-active');
            $tabs.find('> .ui-tabs-panel').not($panel).css('display', 'none').attr('aria-hidden', 'true');
            $panel.css('display', '');
        }

        return true;
    }

    /** Если контейнер ещё не инициализирован как табы — инициализируем сами. */
    function ensureTabsInit($tabs) {
        const hasUiTabs = $tabs.hasClass('ui-tabs');
        let data = null;
        try { data = $tabs.data('ui-tabs') || $tabs.data('tabs'); } catch (e) { data = null; }

        if (!hasUiTabs || !data) {
            try {
                $tabs.tabs({ spinner: '' });
            } catch (e) {
                // уже инициализирован — это нормально
            }
        }
    }

    /**
     * Кнопка обновления у вкладки «Для ТП» — точно как у ERP.
     *
     * ERP работает так: при tabs({refreshButton: true}) создаёт в каждом <li>
     * кнопку `refreshButton-hidden btn-white-hover btn-small`, а при активации
     * вкладки меняет класс hidden > обычный. У неактивных вкладок кнопки не видно.
     *
     * Повторяем ту же механику, но на своём классе tp-refresh: класс refreshButton
     * не используем, иначе ERP считает кнопку своей и добавляет вторую.
     */
    function mountTabRefresh($tabs, panel) {
        if (!panel) return;
        const $li = $tabs.find('> .ui-tabs-nav > li')
            .filter((i, el) => {
                const a = el.querySelector('a');
                return a && (a.getAttribute('href') || '') === '#' + panel.id;
            });
        if (!$li.length) return;

        // Сносим чужие кнопки, которые ERP мог подмешать в наш <li>
        $li.find('button').not('.tp-refresh').remove();

        let $btn = $li.find('button.tp-refresh');
        if (!$btn.length) {
            $btn = $(`<button type="button" class="btn-white-hover btn-small tp-refresh tp-refresh-hidden"
                    title="Обновить данные договора"><span class="ti-reload"></span></button>`);

            $btn.on('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                if ($btn.data('busy')) return;
                $btn.data('busy', true).addClass('is-busy');

                const el = document.getElementById(panel.id);
                // Перерисовка создаст новые таймеры — старый гасим, иначе два опроса
                stopAutoRefresh(el);
                const sess = el && el.querySelector('.tp-sessions');
                if (sess && sess._tpTimer) { clearTimeout(sess._tpTimer); sess._tpTimer = null; }

                Promise.resolve(el ? applyContent(el, contentBuilder) : null)
                    .catch(() => {})
                    .finally(() => {
                        $btn.data('busy', false).removeClass('is-busy');
                    });
            });

            $li.prepend($btn);
        }

        // Синхронизация видимости с состоянием вкладки — как делает jQuery UI у ERP
        syncTabRefresh($li, $btn);
        $tabs.off('tabsactivate.tpRefresh').on('tabsactivate.tpRefresh', () => syncTabRefresh($li, $btn));
    }

    /** Кнопка видна только у активной вкладки — ровно как у ERP. */
    function syncTabRefresh($li, $btn) {
        const active = $li.hasClass('ui-tabs-active') || $li.hasClass('ui-state-active');
        $btn.toggleClass('tp-refresh-hidden', !active);
    }

    /** Перерисовка панели при её показе — не даёт показывать устаревшие данные. */
    function bindRefresh($tabs) {
        if ($tabs.data('tpRefreshBound')) return;
        $tabs.data('tpRefreshBound', true);

        /*
         * Через сколько секунд после сборки панель считается устаревшей.
         * Два порога, а не один: «живые» данные (сессии, ошибки авторизации)
         * устаревают за секунды, «тяжёлые» (баланс, тариф, история статусов,
         * платежи, примечания) — за минуты. Гонять вторую группу при каждом
         * возвращении на вкладку бессмысленно: оператор смотрит на них редко,
         * а запросы к ERP тяжёлые.
         */
        const SHOW_REFRESH = { sessions: 20000, heavy: 300000 };

        const refreshOnShow = (panelId) => {
            const p = document.getElementById(panelId);
            if (!p || p.style.display === 'none') return;

            /*
             * Не перерисовываем на каждый клик по вкладкам.
             *
             * Переключение вкладок ERP (Параметры > Стоимость > Для ТП) — обычное
             * дело, и раньше каждое возвращение запускало полную сборку панели:
             * полтора десятка запросов и пересборку разметки. Оператор, который
             * просто глянул «Параметры» и вернулся, платил за это секундой
             * ожидания. Данные моложе REFRESH_ON_SHOW_MS секунд считаем свежими:
             * сессии всё равно опрашивает собственный таймер панели.
             *
             * Сроки разные по типу данных: деньги и тариф меняются раз в сутки,
             * а сессии — каждую секунду. Поэтому истечение срока не пересобирает
             * панель целиком: сессии просто опрашиваются заново, а тяжёлые
             * блоки (баланс, тариф, история, примечания) живут до 5 минут.
             */
            const now = Date.now();
            const renderedAt = Number(p._tpRenderedAt) || 0;
            const age = renderedAt ? now - renderedAt : Infinity;

            // Панель свежая — ничего не делаем
            if (age < SHOW_REFRESH.sessions) return;

            // Прошло больше сессионного порога: освежаем только живое
            if (age < SHOW_REFRESH.heavy) {
                const card = p.querySelector('.tp-sessions');
                if (card) {
                    netDrop(/sessionAliveContractList|radius\.do/i);
                    loadSessions(card, false).catch(() => null);
                    loadRadiusErrors(p, p.dataset.contractId).catch(() => null);
                }
                return;
            }

            // Прошло больше пяти минут — пересобираем панель полностью
            netDrop(/stoimost|balance|sessionAlive|radius|memoList|method=/i);
            applyContent(p, contentBuilder);
        };

        try {
            $tabs.on('tabsactivate', (event, ui) => {
                if (!ui || !ui.newPanel) return;
                const id = ui.newPanel.attr('id') || '';
                if (id.indexOf(PANEL_ID_BASE) === 0) refreshOnShow(id);
            });
        } catch (e) { /* старый jQuery UI без tabsactivate */ }

        $tabs.find('> .ui-tabs-nav').on('click', 'a', (event) => {
            const href = $(event.currentTarget).attr('href') || '';
            if (href.indexOf('#' + PANEL_ID_BASE) === 0) {
                setTimeout(() => refreshOnShow(href.slice(1)), 0);
            }
        });

        // Кнопка обновления ERP перезагружает ТОЛЬКО свою вкладку и нашу панель
        // не трогает. Исключаем наш <li>, иначе обработчик сработает на своей же кнопке.
        const onErpRefresh = (ev) => {
            const li = ev && ev.target && ev.target.closest
                ? ev.target.closest('li')
                : null;
            const a = li && li.querySelector('a');
            if (a && (a.getAttribute('href') || '').indexOf('#' + PANEL_ID_BASE) === 0) return;

            setTimeout(() => {
                const panel = document.querySelector(PANEL_SEL);
                if (!panel) return;
                // Открытую вкладку перерисовывает tabsactivate, скрытую — только мы
                if (panel.style.display === 'none') {
                    netDrop();
                    applyContent(panel, contentBuilder);
                }
            }, 400);
        };

        // 1) кнопка-иконка в строке вкладок
        $tabs.on('click', 'button.refreshButton-hidden, span.ti-reload', onErpRefresh);
        // 2) пункт меню «Обновить» с onclick на $$.shell.refreshCurrent
        $(document).on('click', 'a[onclick*="refreshCurrent"]', onErpRefresh);
    }

    /** Есть ли сейчас на странице карточка договора. */
    function contractPagePresent() {
        return !!document.querySelector('#treeTable')
            || !!document.querySelector(PANEL_SEL)
            || !!document.getElementById('params')
            || !!document.querySelector('.ui-tabs-nav > li > a[href^="#"]')
            || !!document.querySelector('#content > div[id^="contract_bill-"]')
            || /contract/i.test(location.hash + location.search);
    }

    /**
     * ERP грузит всё AJAX-ом ($$.shell.contentLoad): ни перезагрузки, ни hashchange.
     * Поэтому держим «сторож»: следим за body целиком, а не за #content — его могут пересоздать.
     *
     * Нагрузка на браузер здесь была основной: MutationObserver с subtree:true
     * по всему <body> — это поток мутаций от любой мелочи ERP (курсор, тултип,
     * мигание счётчика), и на каждую пачку вызывался полный tick(): проверка
     * страницы, обход всех .ui-tabs, автовход, поиск. Плюс страховочный
     * setInterval раз в секунду — вечно, даже когда оператор ушёл на другую
     * вкладку. Теперь:
     *  • мутации фильтруются: реагируем только на появление/исчезновение
     *    значимых узлов (#content, карточки договоров, панели вкладок, формы
     *    входа, формы поиска), а не на любую правку текста;
     *  • пачка мутаций склеивается через requestIdleCallback — tick уходит
     *    в свободное время, не отбирая кадры у интерфейса;
     *  • страховочный опрос идёт раз в 4 секунды и полностью замолкает,
     *    пока вкладка браузера скрыта.
     */
    function watch() {
        if (watch.started) return;
        watch.started = true;

        let scheduled = false;
        let retryTimer = null;
        let retryCount = 0;

        const tick = () => {
            scheduled = false;
            // Скрытая вкладка: ни сети, ни DOM-работы. Вернёмся — schedule() придёт
            // от visibilitychange и всё догонит.
            if (document.hidden) return;

            /*
             * Порядок важен для скорости: tick() вызывается на каждый клик,
             * каждый AJAX и каждую значимую мутацию — десятки раз в минуту.
             * authTick/ensureSearchDefaults/bindAutoSearch раньше дёргались
             * ВСЕГДА, хотя 90% времени оператор не на форме входа и не на
             * поиске: authTick читал localStorage, парсил JSON, декодировал
             * base64 и искал форму входа по всему документу. Теперь сначала
             * дешёвые проверки, потом работа.
             */
            if (document.querySelector('input[name="j_username"]')) {
                try { authTick(); } catch (e) { /* окно входа ещё не готово */ }
            }
            if (location.pathname.indexOf('/user/search') >= 0) {
                try { ensureSearchDefaults(); } catch (e) { /* форма ещё не готова */ }
                try { bindAutoSearch(); } catch (e) { /* формы ещё нет */ }
            }

            if (!contractPagePresent()) return;
            try {
                const ok = install();
                retryCount = 0;
                // Если не вышло — попробуем чаще, пока карточка дорисовывается
                if (!ok) retrySoon();
            } catch (e) {
                retrySoon();
            }
        };

        // Короткие повторные попытки: ERP вставляет карточку частями,
        // одного тика в секунду может не хватить.
        //
        // Счётчик обязателен: если install() не может отработать (карточка
        // «битая», jQuery UI ещё не поднялся), без него получался вечный цикл
        // раз в 150 мс с полным обходом всех .ui-tabs документа. После
        // 20 попыток ждём обычного тика — он придёт от таймера или мутации.
        const retrySoon = () => {
            if (retryTimer) return;
            if (retryCount >= 20) return;
            retryCount += 1;
            retryTimer = setTimeout(() => { retryTimer = null; tick(); }, 150);
        };

        // Тик в свободное время: если браузер занят отрисовкой ERP, ждём паузы.
        const run = () => {
            if (window.requestIdleCallback) {
                window.requestIdleCallback(() => tick(), { timeout: 400 });
            } else {
                tick();
            }
        };

        const schedule = () => {
            if (scheduled) return;
            scheduled = true;
            if (window.requestAnimationFrame) {
                window.requestAnimationFrame(run);
            } else {
                setTimeout(run, 0);
            }
        };

        /*
         * Значимые изменения: появился #content, карточка договора, панель вкладок,
         * форма входа или поиска. Всё остальное (правка текста в счётчике,
         * мигание индикатора) — не повод перезапускать install().
         */
        /*
         * Наблюдаем только за «несущими» узлами.
         *
         * Раньше observer висел на всём <body> с subtree:true и вызывал tick()
         * на любую пачку мутаций — включая наши же правки классов в панели и
         * мигание счётчиков ERP. Получался почти непрерывный цикл: tick →
         * перерисовка → мутация → tick. Теперь мутации фильтруются: атрибуты
         * интересны только у карточки договора (её ERP показывает и прячет
         * через style), а из добавленных/удалённых узлов — только значимые.
         */
        const MUTATION_RE = /^(content|head|params|treeTable|searchForms|loginDialog)$|^contract_bill-\d+$|^bgbilling-bill-|^contract-tp-info-|^tp-auth-root$/;
        const CONTRACT_DIV_RE = /^(contract_bill-\d+|bgbilling-bill-[\w-]*)$/;

        const relevant = (node) => {
            if (!node || node.nodeType !== 1) return false;
            if (MUTATION_RE.test(node.id || '')) return true;
            if (node.classList && (node.classList.contains('ui-tabs')
                || node.classList.contains('searchForm'))) return true;
            // Внутри нового узла тоже может быть карточка (ERP вставляет контейнер целиком)
            return !!(node.querySelector && node.querySelector(
                '#content, #treeTable, #searchForms, .ui-tabs, [id^="contract-tp-info-"]'
            ));
        };

        if (window.MutationObserver) {
            const observer = new MutationObserver((records) => {
                for (let i = 0; i < records.length; i += 1) {
                    const r = records[i];

                    if (r.type === 'attributes') {
                        // Только показ/скрытие карточки договора: остальные
                        // class/style-правки — это работа ERP и нашей же панели,
                        // реагировать на них значит крутить tick бесконечно.
                        const t = r.target;
                        if (t && t.id && CONTRACT_DIV_RE.test(t.id)) { schedule(); return; }
                        continue;
                    }

                    const added = r.addedNodes;
                    for (let j = 0; j < added.length; j += 1) {
                        if (relevant(added[j])) { schedule(); return; }
                    }
                    const removed = r.removedNodes;
                    for (let j = 0; j < removed.length; j += 1) {
                        if (relevant(removed[j])) { schedule(); return; }
                    }
                }
            });
            // Наблюдаем <body> целиком: ERP заменяет #content и панели карточек.
            observer.observe(document.body, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['style'],
            });
            watch.observer = observer;
        }

        // Страховка от пропущенных мутаций. Раз в 4 секунды вместо каждой
        // секунды, и только пока вкладка видна: пока оператор работает в другой
        // вкладке или свернул окно, скрипт не делает ничего.
        watch.timer = setInterval(() => {
            if (document.hidden) return;
            schedule();
        }, 4000);

        document.addEventListener('click', schedule, true);
        window.addEventListener('popstate', schedule);
        window.addEventListener('hashchange', schedule);
        // Вернулись на вкладку — сразу проверяем, что карточка на месте
        document.addEventListener('visibilitychange', () => { if (!document.hidden) schedule(); });
        watch.clickHandler = schedule;

        const $ = window.jQuery;
        if ($ && $.fn && $.fn.ajaxComplete) {
            /*
             * AJAX-подгрузки ERP — повод проверить вкладку, но далеко не любой
             * запрос. Панель сама делает полтора десятка вызовов в hydrate(),
             * и каждый из них через ajaxComplete вызывал tick() → install():
             * получался самоподдерживающийся цикл hydrate → AJAX → tick.
             * Реагируем только на то, что может поменять состав #content.
             */
            const NAV_URL = /contract_bill|contentLoad|contract\.do|process\.do|queue\.do|message\.do|customer\.do|search\.do/i;
            $(document).on('ajaxComplete', (ev, xhr, settings) => {
                const url = (settings && settings.url) || '';
                if (!NAV_URL.test(url)) return;
                schedule();
            });
            watch.jq = $;
        }

        schedule();
    }

    /**
     * Остановка «сторожа» и снятие всего, что навесили на страницу.
     *
     * Нужно при перезагрузке скрипта: иначе старая копия продолжает жить,
     * её setInterval и обработчики срабатывают вместе с новыми, и на кнопках
     * остаются замыкания со старой логикой — именно это мешало проверить
     * исправления «Белого IP».
     */
    function teardown() {
        watch.started = false;
        if (watch.timer) { clearInterval(watch.timer); watch.timer = null; }
        if (watch.observer) { watch.observer.disconnect(); watch.observer = null; }

        // Таймеры автообновления всех панелей и сетевой кэш
        document.querySelectorAll(PANEL_SEL).forEach((p) => stopAutoRefresh(p));
        netDrop();

        if (watch.clickHandler) {
            document.removeEventListener('click', watch.clickHandler, true);
            window.removeEventListener('popstate', watch.clickHandler);
            window.removeEventListener('hashchange', watch.clickHandler);
            watch.clickHandler = null;
        }
        if (watch.jq) {
            try { watch.jq(document).off('ajaxComplete'); } catch (e) { /* jQuery уже выгружен */ }
            watch.jq = null;
        }
        // Кнопка «Автозаполнение» в шапке и подложка её панели
        if (authMountLayer.docHandler) {
            document.removeEventListener('mousedown', authMountLayer.docHandler, true);
            authMountLayer.docHandler = null;
        }
        const authRoot = document.getElementById('tp-auth-root');
        if (authRoot) authRoot.remove();
        document.querySelectorAll('.tp-auth-head-btn').forEach((el) => el.remove());
        document.querySelectorAll('.tp-auth-inline').forEach((el) => el.remove());
        document.querySelectorAll('form[data-tp-auth-attached]').forEach((f) => {
            delete f.dataset.tpAuthAttached;
            delete f.dataset.tpAuthDone;
        });
        document.querySelectorAll('form[data-tp-auth-done]').forEach((f) => { delete f.dataset.tpAuthDone; });
        // Стили вынесены из панели в отдельный <style> — убираем вместе с остальным
        const authStyle = document.getElementById('tp-auth-style');
        if (authStyle) authStyle.remove();
        // Стили самой панели тоже снимаем: иначе при переинъекции (обновление
        // скрипта, отладка) injectStyle видит старый <style> и выходит по
        // раннему return — новая копия работает с прежним CSS, и правки
        // оформления «не применяются», хотя в файле они есть.
        const panelStyle = document.getElementById('tp-info-style');
        if (panelStyle) panelStyle.remove();
        // Баннер «доступна новая версия» и его стили
        updateBannerRemove();
    }

    /**
     * Страница «Поиск» (/user/search).
     *
     * ERP рисует свои «селекты» не как <select>, а как div.combo:
     *   div.combo > input[type=hidden] + .text-pref + .text-value + ul.drop > li[value]
     * Поэтому <select> там искать бесполезно. Обработчик выбора у такого комбо —
     * input.onSelect (его ставит $$.ui.combo.single.init), его и вызываем,
     * чтобы ERP переключила форму и подгрузила параметры.
     */

    /** Выбрать в комбобоксе ERP пункт с нужным value (или по тексту). Идемпотентно. */
    function pickCombo(container, value, textRe) {
        if (!container) return false;
        const hidden = container.querySelector('input[type="hidden"]');
        if (!hidden) return false;
        if (hidden.value === value) return false;

        const items = Array.from(container.querySelectorAll('ul.drop > li'));
        const item = items.find((li) => li.getAttribute('value') === value)
            || (textRe ? items.find((li) => textRe.test(li.textContent || '')) : null);
        if (!item) return false;

        const chosen = value || item.getAttribute('value');
        hidden.value = chosen;

        const label = container.querySelector('.text-value');
        if (label) label.textContent = (item.firstChild && item.firstChild.nodeType === 3)
            ? item.firstChild.textContent.trim()
            : item.textContent.trim();

        items.forEach((li) => li.removeAttribute('selected'));
        item.setAttribute('selected', 'selected');

        // ERP ставит обработчик в hidden.onSelect, но иногда такой обработчик
        // недоступен (инициализация комбо происходит позже). Тогда зовём
        // соответствующую глобальную функцию сами.
        let handled = false;
        try {
            if (typeof hidden.onSelect === 'function') {
                hidden.onSelect(item);
                handled = true;
            }
        } catch (e) { /* ERP может ругаться на перерисовку — не критично */ }

        if (!handled && container.id === 'carbonBillingCombo' && typeof window.carbonSwitchBilling === 'function') {
            try { window.carbonSwitchBilling(hidden); handled = true; } catch (e) { /* ignore */ }
        }

        hidden.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    }

    /**
     * Автопоиск по мере ввода.
     *
     * ERP ищет только по Enter (onkeypress > $$.keys.enterPressed) или по кнопке ▶,
     * которая вызывает $$.ajax.load(form, '#searchResult').
     * Мы повторяем ровно то же самое, но через паузу в наборе: результаты
     * приходят в уже существующий #searchResult, без перезагрузки страницы.
     */
    const SEARCH_DEBOUNCE_MS = 350;
    const AUTO_SEARCH_MIN_LEN = 3;
    /**
     * Поиск запускается, когда оператор перестал печатать.
     *
     * Раньше пауза была нулевая, а минимум — один символ: на «Иванов» ERP
     * получала шесть запросов подряд, каждый — полное сканирование договоров.
     * Пока ответ на первый не вернулся, следующие уже в пути, и все они
     * боролись за одни и те же шесть соединений браузера.
     * Теперь ждём паузу в наборе и не ищем по одному символу: результат
     * по одной букве всё равно бесполезен — совпадений сотни.
     * Цифры (номер договора, телефона) ищутся с двух символов.
     */
    const AUTO_SEARCH_MIN_LEN_NUM = 2;

    /** Кнопка поиска для конкретного поля: та, что стоит рядом с ним. */
    function buttonForField(form, input) {
        const row = input.closest('div');
        return row ? row.querySelector('button[onclick]') : null;
    }

    function runAutoSearch(form, input) {
        const btn = buttonForField(form, input);
        if (btn && typeof btn.onclick === 'function') {
            // Родной обработчик ERP: ставит searchBy и грузит #searchResult
            btn.onclick.call(btn, { stopPropagation() {} });
            return;
        }
        // Форма договоров Carbon: отдельная глобальная функция
        if (typeof window.carbonRunSearch === 'function' && form.id === 'searchForm-carbon-searchContract') {
            window.carbonRunSearch(form, 'common');
        }
    }

    function bindAutoSearch() {
        if (!/\/user\/search\b/.test(location.pathname)) return;

        // Ручное переключение «Искать:» — запоминаем, чтобы умолчания не перебили выбор.
        // Обработчик ставим один раз на весь документ, ERP пересоздаёт формы постоянно.
        if (!bindAutoSearch.modeBound) {
            bindAutoSearch.modeBound = true;
            document.addEventListener('click', (ev) => {
                const li = ev.target && ev.target.closest ? ev.target.closest('#searchForm .drop > li') : null;
                if (li) searchDefaultsApplied = true;
            }, true);
        }

        document.querySelectorAll('#searchForms form.searchForm').forEach((form) => {
            if (form.dataset.autoSearchBound) return;
            form.dataset.autoSearchBound = '1';

            const timer = { t: null };

            form.addEventListener('input', (ev) => {
                const input = ev.target;
                if (!input || input.tagName !== 'INPUT') return;
                if (input.type === 'hidden' || input.type === 'checkbox') return;
                if (!input.name || ['searchBy', 'method'].includes(input.name)) return;

                clearTimeout(timer.t);
                const value = String(input.value || '').trim();
                // Одна буква даёт сотни совпадений и полное сканирование на сервере,
                // а номер договора или телефона ищется уже с двух символов.
                const min = /^\d/.test(value) ? AUTO_SEARCH_MIN_LEN_NUM : AUTO_SEARCH_MIN_LEN;
                if (value.length < min) return;

                timer.t = setTimeout(() => {
                    if (!document.contains(form)) return;
                    // Форму успели скрыть (переключили объект поиска) — не ищем
                    if (form.style.display === 'none' || form.offsetParent === null) return;
                    // Значение изменилось, пока ждали паузу — искать будем на следующем вводе
                    if (String(input.value || '').trim() !== value) return;
                    try { runAutoSearch(form, input); } catch (e) { /* ERP сама покажет ошибку */ }
                }, SEARCH_DEBOUNCE_MS);
            });
        });
    }

    /**
     * Переключает видимую форму поиска так же, как ERP, но без гонки:
     * $$.search.onObjectSelect читает скрытый input через jQuery и может взять чужое
     * значение. Здесь форма выбирается по явному id и показывается напрямую.
     */
    function showSearchForm(formId) {
        const target = document.getElementById(formId);
        if (!target) return false;

        document.querySelectorAll('#searchForms form.searchForm').forEach((f) => {
            if (f === target) {
                f.style.display = '';
                f.classList.add('searchForm-active');
            } else {
                f.style.display = 'none';
                f.classList.remove('searchForm-active');
            }
        });
        return true;
    }

    /**
     * Переводит форму «Договор» на BGBilling.
     *
     * ERP-ная carbonSwitchBilling делает это сама, но её вешает только jQuery-инициализация
     * комбо ($$.ui.combo.single.init > hidden.onSelect), а скрипт выставляет значение
     * раньше, чем эта инициализация проходит. Поэтому повторяем её действия здесь:
     *  - форма постит на /user/plugin/dogovor/poisk.do, method пустой, billingId = bill;
     *  - отдельные поля Carbon прячем, остаётся один «Номер, ФИО, телефон или адрес».
     */
    function switchContractToBgbilling(form, billingCombo) {
        if (!form) return false;
        const billing = form.querySelector('input[name="billingId"]');
        const serverId = form.querySelector('input[name="serverId"]');
        const method = form.querySelector('input[name="method"]');
        const query = form.querySelector('input[name="query"]');

        form.setAttribute('action', '/user/plugin/dogovor/poisk.do');
        if (method) method.value = '';
        if (billing) billing.value = 'bill';
        if (serverId) serverId.value = '';

        const separate = document.getElementById('carbonSeparateFields');
        if (separate) separate.style.display = 'none';

        if (query) query.setAttribute('placeholder', 'Номер, ФИО, телефон или адрес');

        if (billingCombo) {
            const label = billingCombo.querySelector('.text-value');
            if (label) label.textContent = 'BGBilling';
            const hidden = billingCombo.querySelector('input[type="hidden"]');
            if (hidden && !hidden.value) hidden.value = 'bgbilling:bill';
        }
        return true;
    }

    /**
     * Флаг «умолчания поиска уже выставлены».
     * watch() крутит tick раз в секунду, и раньше этого флага не было:
     * скрипт каждый тик возвращал режим на «Договор» и не давал выбрать «Процесс».
     * Теперь умолчание ставится один раз при входе на /user/search.
     */
    let searchDefaultsApplied = false;

    /**
     * Переключает режим поиска так же, как это делает клик по пункту списка у ERP.
     *
     * Как устроено в BGERP (по коду страницы):
     *   $$.ui.combo.single.init($comboDiv, onChange) вешает на li клик, который:
     *     - ставит $hidden.val(value)
     *     - обновляет .text-value
     *     - вызывает onChange(item), а тот — $$.search.onObjectSelect()
     *   $$.search.onObjectSelect() скрывает все .searchForm и показывает
     *   $('#searchForm-' + value).
     *
     * Поэтому просто выставить hidden.value НЕДОСТАТОЧНО: форма останется чужой.
     * onSelect лежит в замыкании jQuery (hidden[0].onSelect появляется только
     * после первого ручного клика), поэтому надёжнее вызвать ту же логику самим.
     */
    function setSearchMode(value, textRe) {
        const combo = document.querySelector('#searchForm');
        if (!combo) return false;

        const hidden = combo.querySelector('input[type="hidden"]');
        const items = Array.from(combo.querySelectorAll('ul.drop > li'))
            .filter((li) => !li.classList.contains('filter'));
        if (!hidden || !items.length) return false;

        const item = items.find((li) => li.getAttribute('value') === value)
            || (textRe ? items.find((li) => textRe.test(li.textContent || '')) : null);
        if (!item) return false;

        const chosen = item.getAttribute('value') || value;

        // Тот же набор действий, что делает обработчик клика ERP
        hidden.value = chosen;

        const label = combo.querySelector('.text-value');
        if (label) {
            label.textContent = (item.firstChild && item.firstChild.nodeType === 3)
                ? item.firstChild.textContent.trim()
                : item.textContent.trim();
        }
        items.forEach((li) => li.removeAttribute('selected'));
        item.setAttribute('selected', 'selected');

        // Переключение форм — это и есть $$.search.onObjectSelect()
        return showSearchForm('searchForm-' + chosen);
    }

    /**
     * Ставит поиск на «Договор» + BGBilling.
     * Возвращает true, когда режим и форма реально применены.
     */
    function forceContractSearch() {
        const contractForm = document.getElementById('searchForm-carbon-searchContract');
        if (!contractForm) return false;

        // 1) «Искать:» > Договор. Форма переключится на searchForm-carbon-searchContract
        if (!setSearchMode('carbon-searchContract', /^Договор$/)) return false;

        // Подстраховка: если ERP переписала подпись после смены формы — вернуть
        const modeCombo = document.querySelector('#searchForm');
        const modeLabel = modeCombo && modeCombo.querySelector('.text-value');
        if (modeLabel && !/^Договор$/i.test(modeLabel.textContent.trim())) {
            modeLabel.textContent = 'Договор';
        }

        // 2) «Биллинг:» у договора > BGBilling (value = bgbilling:bill),
        //    затем те же действия, что делает carbonSwitchBilling: форма постит
        //    на /user/plugin/dogovor/poisk.do с billingId=bill и одним полем query.
        const contractBilling = document.getElementById('carbonBillingCombo');
        if (contractBilling) {
            pickCombo(contractBilling, 'bgbilling:bill', /^BGBilling$/);
            const bLabel = contractBilling.querySelector('.text-value');
            if (bLabel) bLabel.textContent = 'BGBilling';
        }
        switchContractToBgbilling(contractForm, contractBilling);

        // 3) В блоке BGBilling «Биллинг:» > BGBilling
        const billingCombo = Array.from(document.querySelectorAll('.combo'))
            .find((c) => /Биллинг/i.test((c.querySelector('.text-pref') || {}).textContent || '')
                && c.id !== 'carbonBillingCombo');
        pickCombo(billingCombo, 'bill', /^BGBilling$/);

        return true;
    }

    function ensureSearchDefaults() {
        if (!/\/user\/search\b/.test(location.pathname)) {
            // Ушли со страницы поиска — при следующем входе снова применим умолчания
            searchDefaultsApplied = false;
            return;
        }

        // Уважаем ручной выбор: если пользователь переключил режим на «Процесс»
        // (или любой другой, кроме ERP-ного дефолта «Контрагент») — не трогаем.
        const modeHidden = document.querySelector('#searchForm input[type="hidden"]');
        const mode = modeHidden ? modeHidden.value : '';
        const userChoseOther = mode && mode !== 'customer' && mode !== 'carbon-searchContract';

        if (userChoseOther) {
            searchDefaultsApplied = true;
            return;
        }

        // ERP при инициализации ставит «Контрагент» и может делать это повторно
        // после перерисовки. Пока режим не «Договор» — ставим умолчание снова.
        if (mode !== 'carbon-searchContract') {
            forceContractSearch();
            return;
        }

        // Режим уже «Договор»: доводим биллинг и поля формы (они могли не примениться)
        if (!searchDefaultsApplied) {
            if (forceContractSearch()) searchDefaultsApplied = true;
        }
    }

    /* ------------------------------------------------- автозаполнение входа */

    /*
     * ERP разлогинивает посреди работы (истёк сеанс) и показывает диалог
     * «Требуется повторный вход» — form#loginDialog с полями j_username/j_password.
     * Оператору приходится каждый раз вбивать логин и пароль заново.
     *
     * Здесь: кнопка «Автозаполнение» (правый нижний угол) с формой логина/пароля
     * и автоматическая подстановка + отправка, как только диалог появился.
     *
     * Про хранение пароля: @grant none, поэтому пишем в localStorage самого
     * sd.org.avanta-telecom.ru. Пароль НЕ шифруется — только кодируется base64,
     * чтобы не лежал в открытом виде в инструментах разработчика и в профиле
     * браузера. Это защита от случайного взгляда, а не от злоумышленника
     * с доступом к машине. Не сохраняйте пароль на чужом компьютере.
     */

    const AUTH_KEY = 'erpTpAuth';
    const AUTH_LAST_SUBMIT_KEY = 'erpTpAuthLastSubmit';
    const AUTH_PAGE_KEY = 'erpTpAuthPage';
    // Если после нашей отправки окно входа появилось снова — пароль, скорее всего,
    // неверный. Столько ждём, прежде чем пробовать автовход опять, чтобы не
    // получить бесконечный цикл «отправил > ошибка > отправил». Пауза короткая:
    // длинная превращается в «скрипт сломался, ничего не заполняется».
    const AUTH_RETRY_BLOCK_MS = 15000;

    const AUTH_CSS = `
        /* Слой-подложка для поповера. Сам он кликов не ловит, чтобы не мешать
           шапке ERP; панель внутри включает pointer-events обратно. */
        #tp-auth-root {
            position: fixed; inset: 0; z-index: 2147483000; pointer-events: none;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, system-ui, sans-serif;
            font-size: 13px; line-height: 1.4; color: #1d1d1f; text-align: left;
        }
        #tp-auth-root * { box-sizing: border-box; }

        /* Кнопка в шапке ERP: та же геометрия, что у соседних иконок.
           Классы btn-white-hover btn-small и иконка ti-* — родные для ERP,
           поэтому кнопка не выбивается из шапки ни в одной теме. */
        .tp-auth-head-btn { position: relative; }
        .tp-auth-head-btn .tp-auth-badge {
            position: absolute; top: -2px; right: -2px;
            width: 8px; height: 8px; border-radius: 50%;
            background: #34c759; border: 1.5px solid #fff;
            box-shadow: 0 0 0 1px rgba(52,199,89,.35);
            pointer-events: none;
        }
        html[data-theme="dark"] .tp-auth-head-btn .tp-auth-badge,
        html[data-theme="modern-dark"] .tp-auth-head-btn .tp-auth-badge {
            border-color: #2c2c2e;
        }

        /* ---------------- панель ---------------- */
        #tp-auth-root .tp-auth-panel {
            position: absolute; width: 320px;
            padding: 0; border-radius: 16px; overflow: hidden;
            background: #fff; border: 1px solid rgba(0,0,0,.07);
            box-shadow: 0 2px 6px rgba(0,0,0,.05), 0 18px 50px -12px rgba(0,0,0,.32);
            pointer-events: auto;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, system-ui, sans-serif;
            font-size: 13px; line-height: 1.45; color: #1d1d1f; text-align: left;
        }
        #tp-auth-root .tp-auth-panel[hidden] { display: none; }
        #tp-auth-root .tp-auth-panel * { box-sizing: border-box; }

        #tp-auth-root .tp-auth-head {
            display: flex; align-items: center; gap: 10px;
            padding: 14px 16px 12px;
            background: linear-gradient(180deg, rgba(0,122,255,.055), rgba(0,122,255,0));
            border-bottom: 1px solid rgba(0,0,0,.06);
        }
        #tp-auth-root .tp-auth-icon {
            width: 30px; height: 30px; flex: 0 0 auto; border-radius: 9px;
            display: flex; align-items: center; justify-content: center;
            background: linear-gradient(180deg, #0a84ff, #0071e3); color: #fff;
            box-shadow: 0 3px 10px -2px rgba(0,113,227,.5);
        }
        #tp-auth-root .tp-auth-icon svg { width: 16px; height: 16px; }
        #tp-auth-root .tp-auth-head-text { min-width: 0; flex: 1 1 auto; }
        #tp-auth-root .tp-auth-title {
            margin: 0; font-size: 13.5px; font-weight: 650; letter-spacing: -.01em;
            color: #1d1d1f;
        }
        #tp-auth-root .tp-auth-sub {
            margin: 1px 0 0; font-size: 11.5px; color: rgba(29,29,31,.5);
        }
        #tp-auth-root .tp-auth-close {
            width: 24px; height: 24px; flex: 0 0 auto; padding: 0;
            border: 0; border-radius: 7px; background: transparent;
            color: rgba(29,29,31,.4); font-size: 17px; line-height: 1; cursor: pointer;
            display: flex; align-items: center; justify-content: center;
        }
        #tp-auth-root .tp-auth-close:hover { background: rgba(0,0,0,.06); color: rgba(29,29,31,.8); }

        #tp-auth-root .tp-auth-body { padding: 14px 16px 16px; }

        #tp-auth-root .tp-auth-field { display: block; margin: 0 0 12px; }
        #tp-auth-root .tp-auth-label {
            display: block; font-size: 11px; font-weight: 600; letter-spacing: .02em;
            color: rgba(29,29,31,.5); margin: 0 0 5px;
        }
        #tp-auth-root input[type="text"],
        #tp-auth-root input[type="password"] {
            display: block; width: 100%; height: 34px; padding: 0 11px; margin: 0;
            border: 1px solid rgba(0,0,0,.14); border-radius: 10px;
            background: #fbfbfd; color: #1d1d1f; font: inherit; outline: none;
            transition: border-color .15s ease, box-shadow .15s ease, background .15s ease;
        }
        #tp-auth-root input[type="text"]:hover,
        #tp-auth-root input[type="password"]:hover { border-color: rgba(0,0,0,.22); }
        #tp-auth-root input[type="text"]:focus,
        #tp-auth-root input[type="password"]:focus {
            background: #fff; border-color: #007aff; box-shadow: 0 0 0 3.5px rgba(0,122,255,.15);
        }

        /* Переключатель автовхода вместо галочки — привычнее и компактнее */
        #tp-auth-root .tp-auth-switch {
            display: flex; align-items: center; gap: 10px; margin: 2px 0 14px;
            cursor: pointer; user-select: none;
        }
        #tp-auth-root .tp-auth-switch input { position: absolute; opacity: 0; width: 0; height: 0; }
        #tp-auth-root .tp-auth-switch-track {
            position: relative; width: 36px; height: 21px; flex: 0 0 auto;
            border-radius: 999px; background: rgba(120,120,128,.28);
            transition: background .2s ease;
        }
        #tp-auth-root .tp-auth-switch-thumb {
            position: absolute; top: 2px; left: 2px; width: 17px; height: 17px;
            border-radius: 50%; background: #fff;
            box-shadow: 0 1px 3px rgba(0,0,0,.28);
            transition: transform .2s cubic-bezier(.32,.72,0,1);
        }
        #tp-auth-root .tp-auth-switch input:checked + .tp-auth-switch-track { background: #34c759; }
        #tp-auth-root .tp-auth-switch input:checked + .tp-auth-switch-track .tp-auth-switch-thumb {
            transform: translateX(15px);
        }
        #tp-auth-root .tp-auth-switch input:focus-visible + .tp-auth-switch-track {
            box-shadow: 0 0 0 3.5px rgba(0,122,255,.2);
        }
        #tp-auth-root .tp-auth-switch-text { font-size: 12.5px; color: rgba(29,29,31,.72); }

        #tp-auth-root .tp-auth-btns { display: flex; gap: 8px; }
        #tp-auth-root .tp-auth-btn {
            flex: 1 1 auto; height: 34px; padding: 0 14px; border-radius: 10px;
            border: 1px solid rgba(0,0,0,.1); background: #f2f2f7; color: #1d1d1f;
            font: inherit; font-size: 12.5px; font-weight: 600; cursor: pointer;
            transition: background .15s ease, border-color .15s ease, transform .06s ease;
        }
        #tp-auth-root .tp-auth-btn:hover { background: #e9e9ef; }
        #tp-auth-root .tp-auth-btn:active { transform: scale(.985); }
        #tp-auth-root .tp-auth-btn.is-primary {
            flex: 1.4 1 auto; border-color: transparent; color: #fff;
            background: linear-gradient(180deg, #0a84ff, #0071e3);
            box-shadow: 0 2px 8px -2px rgba(0,113,227,.55);
        }
        #tp-auth-root .tp-auth-btn.is-primary:hover {
            background: linear-gradient(180deg, #1a8cff, #0a7aec);
        }
        #tp-auth-root .tp-auth-btn.is-quiet {
            flex: 0 0 auto; background: transparent; border-color: transparent;
            color: rgba(29,29,31,.5); font-weight: 500;
        }
        #tp-auth-root .tp-auth-btn.is-quiet:hover { background: rgba(0,0,0,.05); color: #ff3b30; }

        #tp-auth-root .tp-auth-note {
            margin: 12px 0 0; font-size: 10.5px; line-height: 1.4;
            color: rgba(29,29,31,.4);
        }
        #tp-auth-root .tp-auth-msg {
            margin: 0; font-size: 11.5px; font-weight: 600; color: #34c759;
        }
        #tp-auth-root .tp-auth-msg.is-error { color: #ff3b30; }
        #tp-auth-root .tp-auth-msg:empty { display: none; }
        #tp-auth-root .tp-auth-msg:not(:empty) { margin-top: 10px; }

        /* ---------------- тёмные темы ERP ---------------- */
        html[data-theme="dark"] #tp-auth-root .tp-auth-panel,
        html[data-theme="modern-dark"] #tp-auth-root .tp-auth-panel {
            background: #2c2c2e; border-color: rgba(255,255,255,.1);
            box-shadow: 0 2px 6px rgba(0,0,0,.4), 0 18px 50px -12px rgba(0,0,0,.85);
            color: #f5f5f7;
        }
        html[data-theme="dark"] #tp-auth-root .tp-auth-head,
        html[data-theme="modern-dark"] #tp-auth-root .tp-auth-head {
            background: linear-gradient(180deg, rgba(10,132,255,.14), rgba(10,132,255,0));
            border-bottom-color: rgba(255,255,255,.09);
        }
        html[data-theme="dark"] #tp-auth-root .tp-auth-title,
        html[data-theme="modern-dark"] #tp-auth-root .tp-auth-title { color: #f5f5f7; }
        html[data-theme="dark"] #tp-auth-root .tp-auth-sub,
        html[data-theme="dark"] #tp-auth-root .tp-auth-note,
        html[data-theme="modern-dark"] #tp-auth-root .tp-auth-sub,
        html[data-theme="modern-dark"] #tp-auth-root .tp-auth-note { color: rgba(245,245,247,.45); }
        html[data-theme="dark"] #tp-auth-root .tp-auth-label,
        html[data-theme="modern-dark"] #tp-auth-root .tp-auth-label { color: rgba(245,245,247,.55); }
        html[data-theme="dark"] #tp-auth-root .tp-auth-switch-text,
        html[data-theme="modern-dark"] #tp-auth-root .tp-auth-switch-text { color: rgba(245,245,247,.75); }
        html[data-theme="dark"] #tp-auth-root .tp-auth-close,
        html[data-theme="modern-dark"] #tp-auth-root .tp-auth-close { color: rgba(245,245,247,.45); }
        html[data-theme="dark"] #tp-auth-root .tp-auth-close:hover,
        html[data-theme="modern-dark"] #tp-auth-root .tp-auth-close:hover {
            background: rgba(255,255,255,.1); color: #fff;
        }
        html[data-theme="dark"] #tp-auth-root input[type="text"],
        html[data-theme="dark"] #tp-auth-root input[type="password"],
        html[data-theme="modern-dark"] #tp-auth-root input[type="text"],
        html[data-theme="modern-dark"] #tp-auth-root input[type="password"] {
            background: rgba(255,255,255,.06); border-color: rgba(255,255,255,.16); color: #f5f5f7;
        }
        html[data-theme="dark"] #tp-auth-root input[type="text"]:focus,
        html[data-theme="dark"] #tp-auth-root input[type="password"]:focus,
        html[data-theme="modern-dark"] #tp-auth-root input[type="text"]:focus,
        html[data-theme="modern-dark"] #tp-auth-root input[type="password"]:focus {
            background: rgba(255,255,255,.1); border-color: #0a84ff;
        }
        html[data-theme="dark"] #tp-auth-root .tp-auth-switch-track,
        html[data-theme="modern-dark"] #tp-auth-root .tp-auth-switch-track {
            background: rgba(255,255,255,.22);
        }
        html[data-theme="dark"] #tp-auth-root .tp-auth-btn,
        html[data-theme="modern-dark"] #tp-auth-root .tp-auth-btn {
            background: rgba(255,255,255,.1); border-color: rgba(255,255,255,.12); color: #f5f5f7;
        }
        html[data-theme="dark"] #tp-auth-root .tp-auth-btn:hover,
        html[data-theme="modern-dark"] #tp-auth-root .tp-auth-btn:hover { background: rgba(255,255,255,.16); }
        html[data-theme="dark"] #tp-auth-root .tp-auth-btn.is-quiet,
        html[data-theme="modern-dark"] #tp-auth-root .tp-auth-btn.is-quiet {
            background: transparent; border-color: transparent; color: rgba(245,245,247,.5);
        }

        /* ---------------- кнопки внутри окна входа ERP ---------------- */
        form .tp-auth-inline {
            display: flex; align-items: center; gap: 8px; margin: 8px 0 0;
            flex-wrap: wrap;
        }
        form .tp-auth-inline .tp-auth-inline-btn {
            flex: 1 1 auto; min-width: 0; height: 32px; padding: 0 12px;
            display: inline-flex; align-items: center; justify-content: center; gap: 6px;
            border-radius: 8px; border: 1px solid transparent; cursor: pointer;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, system-ui, sans-serif;
            font-size: 12.5px; font-weight: 600; color: #fff;
            background: linear-gradient(180deg, #0a84ff, #0071e3);
            box-shadow: 0 2px 8px -2px rgba(0,113,227,.5);
            white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
            transition: filter .15s ease, transform .06s ease;
        }
        form .tp-auth-inline .tp-auth-inline-btn:hover { filter: brightness(1.07); }
        form .tp-auth-inline .tp-auth-inline-btn:active { transform: scale(.985); }
        form .tp-auth-inline .tp-auth-inline-btn svg { width: 13px; height: 13px; flex: 0 0 auto; }
        form .tp-auth-inline .tp-auth-inline-link {
            flex: 0 0 auto; height: 32px; padding: 0 10px; border-radius: 8px;
            border: 1px solid rgba(0,0,0,.12); background: #f2f2f7;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, system-ui, sans-serif;
            font-size: 12px; font-weight: 600; color: #007aff; cursor: pointer;
            transition: background .15s ease;
        }
        form .tp-auth-inline .tp-auth-inline-link:hover { background: #e9e9ef; }
        form .tp-auth-inline-hint {
            flex: 1 1 100%; margin: 0; font-size: 11px; line-height: 1.35;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, system-ui, sans-serif;
            color: rgba(29,29,31,.5);
        }
        form .tp-auth-inline-hint.is-error { color: #ff3b30; font-weight: 600; }
        form .tp-auth-inline-hint:empty { display: none; }
    `;

    /**
     * Стили вставляем в head сразу при старте, а не вместе с панелью.
     *
     * Раньше AUTH_CSS лежал внутри #tp-auth-root, который создавался только
     * при открытии панели. Из-за этого до первого клика на странице не было
     * ни стилей кнопки в шапке (не рисовался зелёный индикатор), ни стилей
     * кнопок в окне входа — они выглядели как нативные кнопки браузера.
     */
    function authInjectStyle() {
        if (document.getElementById('tp-auth-style')) return;
        const host = document.head || document.documentElement;
        if (!host) return;
        const el = document.createElement('style');
        el.id = 'tp-auth-style';
        el.textContent = AUTH_CSS;
        host.appendChild(el);
    }


    /** Подпись под кнопкой в окне входа: почему автовход не сработал. */
    function authSetInlineHint(wrap, text, isError) {
        if (!wrap) return;
        const hint = wrap.querySelector('.tp-auth-inline-hint');
        if (!hint) return;
        hint.textContent = text || '';
        hint.classList.toggle('is-error', !!isError);
    }

    /** localStorage может быть недоступен (приватный режим, политики) — не падаем. */
    function authStore() {
        try {
            const ls = window.localStorage;
            ls.getItem(AUTH_KEY);
            return ls;
        } catch (e) {
            return null;
        }
    }

    /** base64 для UTF-8 строк: btoa не умеет не-латиницу (кириллица в пароле). */
    function authB64Encode(text) {
        const bytes = new TextEncoder().encode(String(text == null ? '' : text));
        let bin = '';
        bytes.forEach((b) => { bin += String.fromCharCode(b); });
        return btoa(bin);
    }

    function authB64Decode(b64) {
        const bin = atob(String(b64 || ''));
        const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
        return new TextDecoder().decode(bytes);
    }

    /** Сохранённые данные входа. Пустые значения — «ничего не сохранено». */
    function authLoad() {
        const empty = { login: '', password: '', auto: true };
        const ls = authStore();
        if (!ls) return empty;
        try {
            const raw = ls.getItem(AUTH_KEY);
            if (!raw) return empty;
            const obj = JSON.parse(raw) || {};
            let password = '';
            try { password = obj.password ? authB64Decode(obj.password) : ''; } catch (e) { password = ''; }
            return {
                login: String(obj.login || ''),
                password,
                auto: obj.auto !== false,
            };
        } catch (e) {
            return empty;
        }
    }

    function authSave(creds) {
        const ls = authStore();
        if (!ls) return false;
        try {
            if (!creds.login && !creds.password) {
                ls.removeItem(AUTH_KEY);
                return true;
            }
            ls.setItem(AUTH_KEY, JSON.stringify({
                v: 1,
                login: String(creds.login || ''),
                password: authB64Encode(creds.password || ''),
                auto: creds.auto !== false,
            }));
            return true;
        } catch (e) {
            return false;
        }
    }

    function authClear() {
        const ls = authStore();
        if (!ls) return;
        try { ls.removeItem(AUTH_KEY); } catch (e) { /* ignore */ }
    }

    function authLastSubmitAt() {
        const ls = authStore();
        if (!ls) return 0;
        try { return Number(ls.getItem(AUTH_LAST_SUBMIT_KEY)) || 0; } catch (e) { return 0; }
    }

    function authMarkSubmit() {
        const ls = authStore();
        if (!ls) return;
        try {
            ls.setItem(AUTH_LAST_SUBMIT_KEY, String(Date.now()));
            ls.setItem(AUTH_PAGE_KEY, authPageId());
        } catch (e) { /* ignore */ }
    }

    /** Вход удался: снимаем «паузу после неудачи», иначе она съест следующий автовход. */
    function authMarkSuccess() {
        const ls = authStore();
        if (!ls) return;
        try { ls.removeItem(AUTH_LAST_SUBMIT_KEY); ls.removeItem(AUTH_PAGE_KEY); } catch (e) { /* ignore */ }
    }

    /**
     * Успел ли предыдущий submit привести к перезагрузке страницы.
     *
     * Неудачный вход в ERP остаётся в том же документе (ошибка пишется в
     * #loginErrorMessage), а удачный обычно уводит на другую страницу.
     * Значит, если отметка о submit осталась от ДРУГОГО экземпляра страницы —
     * вход прошёл, и паузу надо снять, иначе после F5 автовход «залипнет».
     */
    function authClearSubmitIfNavigated() {
        const ls = authStore();
        if (!ls) return;
        try {
            const prevPage = ls.getItem(AUTH_PAGE_KEY);
            if (prevPage && prevPage !== authPageId()) authMarkSuccess();
        } catch (e) { /* ignore */ }
    }

    /** Уникальный id текущего экземпляра страницы (живёт до перезагрузки). */
    function authPageId() {
        if (!authPageId.value) {
            authPageId.value = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        }
        return authPageId.value;
    }

    /**
     * Окно входа закрылось само — значит, авторизация прошла.
     * Отмечаем это один раз на попытку: если ERP потом снова разлогинит,
     * автовход должен сработать сразу, а не ждать конца паузы.
     */
    function authNoteFormGone() {
        const submittedAt = authLastSubmitAt();
        if (!submittedAt || authNoteFormGone.done) return;
        authNoteFormGone.done = true;
        authMarkSuccess();
        setTimeout(() => { authNoteFormGone.done = false; }, 2000);
    }

    /**
     * Видимость элемента.
     *
     * offsetParent здесь не годится: диалог jQuery UI имеет position: fixed,
     * а у таких элементов offsetParent всегда null — форма считалась бы скрытой.
     */
    function authVisible(el) {
        if (!el || !el.isConnected) return false;
        if (!el.getClientRects().length) return false;
        const cs = getComputedStyle(el);
        return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
    }

    /**
     * Форма входа: и диалог «Требуется повторный вход», и обычная страница логина —
     * у обеих поля называются j_username / j_password.
     */
    function authLoginForm() {
        const candidates = document.querySelectorAll('input[name="j_username"]');
        for (const input of candidates) {
            const form = input.form || input.closest('form');
            if (!form) continue;
            if (!form.querySelector('input[name="j_password"]')) continue;
            if (!authVisible(input) || !authVisible(form)) continue;
            return form;
        }
        return null;
    }

    /** Подставляет логин и пароль, не трогая поля, если там уже то же самое. */
    function authFill(form, creds) {
        const user = form.querySelector('input[name="j_username"]');
        const pass = form.querySelector('input[name="j_password"]');
        if (!user || !pass) return false;

        let changed = false;
        if (user.value !== creds.login) { user.value = creds.login; changed = true; }
        if (pass.value !== creds.password) { pass.value = creds.password; changed = true; }
        if (!changed) return false;

        // ERP читает значения при submit, но событий ждут и её обработчики валидации
        [user, pass].forEach((el) => {
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        });
        return true;
    }

    /** Отправка формы так же, как это сделал бы Enter в поле. */
    function authSubmit(form) {
        const btn = form.querySelector('button[type="submit"], input[type="submit"]');
        if (btn) {
            btn.click();
            return true;
        }
        if (typeof form.requestSubmit === 'function') {
            form.requestSubmit();
            return true;
        }
        return false;
    }

    /* --- кнопка «Автозаполнение» и её панель --- */

    let authPanelMsgTimer = null;

    function authSetMsg(text, isError) {
        const root = document.getElementById('tp-auth-root');
        const msg = root && root.querySelector('.tp-auth-msg');
        if (!msg) return;
        msg.textContent = text || '';
        msg.classList.toggle('is-error', !!isError);
        clearTimeout(authPanelMsgTimer);
        if (text) {
            authPanelMsgTimer = setTimeout(() => {
                if (document.contains(msg)) msg.textContent = '';
            }, 3500);
        }
    }

    /**
     * Состояние кнопки в шапке: зелёная точка = данные сохранены,
     * подсказка в title — какой логин запомнен и включён ли автовход.
     */
    function authSyncHeadButton() {
        const creds = authLoad();
        const btn = authMountHeadButton();
        if (btn) {
            const saved = !!(creds.login && creds.password);
            const title = saved
                ? `Автозаполнение входа: ${creds.login}${creds.auto ? ' (автовход включён)' : ' (автовход выключен)'}`
                : 'Автозаполнение входа: логин и пароль не сохранены';
            // Сверяем перед записью: tick() крутится часто, лишние записи в DOM не нужны
            if (btn.title !== title) btn.title = title;
            const has = btn.classList.contains('tp-auth-saved');
            if (has !== saved) btn.classList.toggle('tp-auth-saved', saved);

            // Индикатор — отдельный элемент, а не ::after: псевдоэлемент не виден,
            // пока на странице нет наших стилей, а точка нужна всегда.
            let badge = btn.querySelector('.tp-auth-badge');
            if (saved && !badge) {
                badge = document.createElement('span');
                badge.className = 'tp-auth-badge';
                btn.appendChild(badge);
            } else if (!saved && badge) {
                badge.remove();
            }
        }
        return creds;
    }

    /** Заполняет поля панели сохранёнными данными (панель живёт в #tp-auth-root). */
    function authFillPanelInputs(creds) {
        const root = document.getElementById('tp-auth-root');
        if (!root) return;
        const login = root.querySelector('.tp-auth-login');
        const pass = root.querySelector('.tp-auth-pass');
        const auto = root.querySelector('.tp-auth-auto');
        if (login) login.value = creds.login || '';
        if (pass) pass.value = creds.password || '';
        if (auto) auto.checked = creds.auto !== false;
    }

    /**
     * Кнопка «Автозаполнение» в шапке ERP.
     *
     * Ставим её в `.right` рядом с переключателем темы — там же, где остальные
     * иконки шапки. Классы `btn-white-hover btn-small` и иконка `ti-*` родные
     * для ERP, поэтому кнопка наследует высоту, отступы и подсветку от соседей
     * и не выбивается из шапки ни в одной из тем.
     */
    function authMountHeadButton() {
        const head = document.querySelector('#head');
        if (!head) return null;

        let btn = head.querySelector('.tp-auth-head-btn');
        if (btn) return btn;

        const right = head.querySelector('.right') || head;
        const themeSwitch = right.querySelector('.theme-switch');

        btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn-white-hover btn-small tp-auth-head-btn';
        btn.title = 'Автозаполнение входа';
        btn.innerHTML = '<i class="ti-key"></i>';

        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            authTogglePanel(btn);
        });

        if (themeSwitch && themeSwitch.parentNode === right) {
            right.insertBefore(btn, themeSwitch);
        } else {
            right.appendChild(btn);
        }
        return btn;
    }

    /** Подложка для панели: живёт в body, чтобы её не срезал overflow шапки. */
    function authMountLayer() {
        authInjectStyle();
        if (!document.body) return null;
        let root = document.getElementById('tp-auth-root');
        if (root && root.isConnected) return root;
        if (root) root.remove();

        root = document.createElement('div');
        root.id = 'tp-auth-root';
        root.innerHTML = `
            <div class="tp-auth-panel" hidden>
                <div class="tp-auth-head">
                    <span class="tp-auth-icon" aria-hidden="true">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                             stroke-linecap="round" stroke-linejoin="round">
                            <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"></path>
                        </svg>
                    </span>
                    <span class="tp-auth-head-text">
                        <p class="tp-auth-title">Автозаполнение входа</p>
                        <p class="tp-auth-sub">Данные хранятся только в этом браузере</p>
                    </span>
                    <button type="button" class="tp-auth-close" data-act="close" title="Закрыть">&times;</button>
                </div>
                <div class="tp-auth-body">
                    <label class="tp-auth-field">
                        <span class="tp-auth-label">Логин</span>
                        <input type="text" class="tp-auth-login" autocomplete="username" spellcheck="false" placeholder="j_username">
                    </label>
                    <label class="tp-auth-field">
                        <span class="tp-auth-label">Пароль</span>
                        <input type="password" class="tp-auth-pass" autocomplete="current-password" placeholder="j_password">
                    </label>
                    <label class="tp-auth-switch">
                        <input type="checkbox" class="tp-auth-auto">
                        <span class="tp-auth-switch-track"><span class="tp-auth-switch-thumb"></span></span>
                        <span class="tp-auth-switch-text">Входить автоматически</span>
                    </label>
                    <div class="tp-auth-btns">
                        <button type="button" class="tp-auth-btn is-primary" data-act="save">Сохранить</button>
                        <button type="button" class="tp-auth-btn is-quiet" data-act="clear">Забыть</button>
                    </div>
                    <div class="tp-auth-msg"></div>
                    <p class="tp-auth-note">Пароль лежит в localStorage сайта в кодированном, но не зашифрованном виде. Не сохраняйте его на чужом компьютере.</p>
                </div>
            </div>`;

        document.body.appendChild(root);

        // Клик мимо панели — закрыть. Саму кнопку шапки исключаем: её клик
        // тоже переключает панель, иначе она закрывалась бы и открывалась сразу.
        const onDocMouseDown = (e) => {
            const panel = root.querySelector('.tp-auth-panel');
            if (!panel || panel.hidden) return;
            if (root.contains(e.target)) return;
            if (e.target.closest && e.target.closest('.tp-auth-head-btn')) return;
            panel.hidden = true;
        };
        document.addEventListener('mousedown', onDocMouseDown, true);
        authMountLayer.docHandler = onDocMouseDown;

        root.addEventListener('click', (e) => {
            const el = e.target.closest ? e.target.closest('[data-act]') : null;
            if (!el) return;
            e.preventDefault();

            const act = el.getAttribute('data-act');
            if (act === 'save') {
                const login = (root.querySelector('.tp-auth-login').value || '').trim();
                const password = root.querySelector('.tp-auth-pass').value || '';
                const auto = !!root.querySelector('.tp-auth-auto').checked;
                if (!login || !password) {
                    authSetMsg('Заполните логин и пароль.', true);
                    return;
                }
                if (authSave({ login, password, auto })) {
                    authSyncHeadButton();
                    authSetMsg('Сохранено.');
                } else {
                    authSetMsg('Браузер запретил сохранение.', true);
                }
                return;
            }

            if (act === 'clear') {
                authClear();
                authFillPanelInputs(authLoad());
                authSyncHeadButton();
                authSetMsg('Сохранённые данные удалены.');
                return;
            }

            if (act === 'close') {
                const panel = root.querySelector('.tp-auth-panel');
                if (panel) panel.hidden = true;
            }
        });

        authFillPanelInputs(authLoad());
        return root;
    }

    /** Панель ставим под кнопкой, выравнивая правый край — как меню у иконок шапки. */
    function authPositionPanel(btn) {
        const root = document.getElementById('tp-auth-root');
        const panel = root && root.querySelector('.tp-auth-panel');
        if (!panel || !btn) return;
        const r = btn.getBoundingClientRect();
        const width = panel.offsetWidth || 320;
        // Не вылезаем за правый край экрана
        const left = Math.min(Math.max(8, r.right - width), window.innerWidth - width - 8);
        panel.style.left = `${Math.round(left)}px`;
        panel.style.top = `${Math.round(r.bottom + 8)}px`;
    }

    function authTogglePanel(btn) {
        const root = authMountLayer();
        const panel = root && root.querySelector('.tp-auth-panel');
        if (!panel) return;
        if (panel.hidden) {
            authFillPanelInputs(authLoad());
            authPositionPanel(btn);
            panel.hidden = false;
            const login = root.querySelector('.tp-auth-login');
            if (login) login.focus();
        } else {
            panel.hidden = true;
        }
    }

    /** Открыть настройки из окна входа: не надо искать кнопку в шапке. */
    function authOpenPanelFromDialog() {
        const btn = authMountHeadButton();
        const root = authMountLayer();
        const panel = root && root.querySelector('.tp-auth-panel');
        if (!panel) return false;
        authFillPanelInputs(authLoad());
        authPositionPanel(btn);
        panel.hidden = false;
        const login = root.querySelector('.tp-auth-login');
        if (login) login.focus();
        return true;
    }


    /**
     * Кнопка «Заполнить и войти» прямо в окне входа: пригодится, когда автовход
     * выключен или сработал не сразу — не надо лезть в панель настроек.
     */
    function authAttachToDialog(form) {
        if (!form || form.dataset.tpAuthAttached === '1') return;
        const submit = form.querySelector('button[type="submit"], input[type="submit"]');
        if (!submit || !submit.parentNode) return;
        // ERP могла перерисовать форму и потерять нашу строку — ставим заново
        form.dataset.tpAuthAttached = '1';
        if (form.querySelector('.tp-auth-inline')) return;

        const creds = authLoad();
        const wrap = document.createElement('div');
        wrap.className = 'tp-auth-inline';

        const fillBtn = document.createElement('button');
        fillBtn.type = 'button';
        fillBtn.className = 'tp-auth-inline-btn';
        // Иконка ключа + текст: кнопка должна читаться как действие, а не как поле
        fillBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"></path>
            <polyline points="10 17 15 12 10 7"></polyline>
            <line x1="15" y1="12" x2="3" y2="12"></line></svg>`;
        const fillLabel = document.createElement('span');
        fillLabel.className = 'tp-auth-inline-label';
        fillLabel.textContent = creds.login ? `Войти как ${creds.login}` : 'Заполнить и войти';
        fillBtn.appendChild(fillLabel);

        fillBtn.addEventListener('click', (e) => {
            e.preventDefault();
            const now = authLoad();
            if (!now.login || !now.password) {
                authSetInlineHint(wrap, 'Логин и пароль ещё не сохранены.', true);
                return;
            }
            authFill(form, now);
            authMarkSubmit();
            authSubmit(form);
        });

        const cfgBtn = document.createElement('button');
        cfgBtn.type = 'button';
        cfgBtn.className = 'tp-auth-inline-link';
        cfgBtn.textContent = 'Настроить';
        cfgBtn.addEventListener('click', (e) => {
            e.preventDefault();
            authOpenPanelFromDialog();
        });

        wrap.appendChild(fillBtn);
        wrap.appendChild(cfgBtn);
        // Строка состояния автовхода: сюда пишем, почему вход не произошёл сам
        const hint = document.createElement('div');
        hint.className = 'tp-auth-inline-hint';
        wrap.appendChild(hint);
        // Ставим сразу под кнопкой «Войти», внутри формы — чтобы не разъезжалось с диалогом
        submit.parentNode.insertBefore(wrap, submit.nextSibling);
    }

    /** Главный шаг: смонтировать кнопку в шапке и, если настроено, войти автоматически. */
    function authTick() {
        // Стили нужны и до открытия панели: от них зависят кнопка в шапке
        // и кнопки в окне входа. ERP может пересоздать head — проверка дешёвая.
        authInjectStyle();
        authSyncHeadButton();

        // Страница перезагрузилась после нашего submit — вход прошёл, снимаем паузу
        authClearSubmitIfNavigated();

        const creds = authLoad();
        const form = authLoginForm();
        if (!form) {
            // Окно закрылось/исчезло — снимаем отметку, чтобы при следующем
            // истечении сеанса автовход сработал снова (ERP может переиспользовать форму).
            document.querySelectorAll('form[data-tp-auth-done]').forEach((f) => {
                delete f.dataset.tpAuthDone;
            });
            authNoteFormGone();
            return;
        }

        authAttachToDialog(form);
        const wrap = form.querySelector('.tp-auth-inline');
        // Подпись кнопки в окне входа: логин мог появиться уже после её вставки.
        // Пишем в span, а не в кнопку целиком — иначе затрём иконку.
        const fillBtn = wrap && wrap.querySelector('.tp-auth-inline-btn');
        const fillLabel = fillBtn && fillBtn.querySelector('.tp-auth-inline-label');
        if (fillLabel) {
            const label = creds.login ? `Войти как ${creds.login}` : 'Заполнить и войти';
            if (fillLabel.textContent !== label) fillLabel.textContent = label;
        }

        if (!creds.login || !creds.password) {
            authSetInlineHint(wrap, 'Заполните логин и пароль в кнопке «Автозаполнение».', false);
            return;
        }

        // Поля заполняем всегда, когда есть сохранённые данные — даже если автовход
        // выключен или приостановлен: оператору останется нажать «Войти».
        authFill(form, creds);

        // ERP пишет причину отказа в #loginErrorMessage («Неверный пароль» и т.п.).
        // Показываем её как есть — это точнее любой нашей догадки.
        const errBox = form.querySelector('#loginErrorMessage');
        const erpError = errBox ? String(errBox.textContent || '').trim() : '';

        if (!creds.auto) {
            authSetInlineHint(wrap, 'Автовход выключен — нажмите кнопку выше.', false);
            return;
        }
        // Эта форма уже обработана: не отправляем повторно и не пугаем «паузой»,
        // пока ERP её не пересоздаст. Иначе собственная же отправка выглядела бы
        // как неудачная попытка.
        if (form.dataset.tpAuthDone === '1') return;

        // Форма новая, а предыдущий submit был совсем недавно — вход не удался.
        // Пауза, чтобы не крутить цикл «отправил > отказ > отправил».
        if (Date.now() - authLastSubmitAt() < AUTH_RETRY_BLOCK_MS) {
            form.dataset.tpAuthDone = '1';
            authSetInlineHint(wrap,
                erpError || 'Автовход приостановлен на 15 секунд: проверьте пароль.', true);
            authSetMsg('Автовход приостановлен: проверьте пароль.', true);
            return;
        }

        form.dataset.tpAuthDone = '1';
        authSetInlineHint(wrap, `Входим как ${creds.login}…`, false);
        authMarkSubmit();
        authSubmit(form);
    }

    /* --------------------------------------------- проверка обновлений */

    /*
     * Штатное автообновление (@updateURL) работает, но не мгновенно: Tampermonkey
     * опрашивает сервер примерно раз в сутки, а после выхода новой версии
     * оператор продолжает работать на старой до следующего опроса. Заметить это
     * невозможно — вкладка выглядит рабочей, просто ведёт себя по-старому.
     *
     * Здесь скрипт сам спрашивает свою версию с сервера и, если она новее,
     * показывает баннер «доступна новая версия» с кнопкой перезагрузки.
     *
     * @grant none, поэтому только fetch: читаем сам файл скрипта и сравниваем
     * @version. Браузер отдаст его из кэша — для проверки это не страшно, а
     * чтобы не залипнуть на старом кэше навсегда, добавляем cache: 'no-store'.
     */

    // Для проверки хватает шапки скрипта (.meta.js, ~1 КБ), а не всего файла
    // на 490 КБ: иначе каждый оператор несколько раз в день качал бы полный
    // файл ради одной строки с версией.
    const SELF_URL = 'https://raw.githubusercontent.com/krasht/ERP_TAB/main/erp-contract-tp-tab.user.js';
    const SELF_META_URL = 'https://raw.githubusercontent.com/krasht/ERP_TAB/main/erp-contract-tp-tab.meta.js';
    const UPDATE_CHECK_KEY = 'erpTpUpdateCheckedAt';
    // Tampermonkey сам опрашивает сервер не чаще раза в 6 часов (это его
    // минимум), поэтому свежесть релиза держим своей проверкой.
    //
    // Проверяем при КАЖДОЙ загрузке страницы: .meta.js весит меньше 1 КБ,
    // а перезагрузка ERP — осознанное действие оператора. Заставлять его
    // ждать 15 минут ради экономии килобайта незачем: он и так только что
    // нажал F5, значит готов увидеть свежую версию.
    //
    // Ограничитель остался только для возврата на вкладку: переключение
    // туда-обратно иначе давало бы запрос на каждое движение мышью.
    const UPDATE_FOCUS_MIN_MS = 60 * 1000;
    // Ручной запуск из консоли ждёт кэш CDN: у GitHub raw он до 5 минут,
    // и проверять чаще бессмысленно — сервер вернёт ту же шапку.
    const UPDATE_CDN_MIN_MS = 5 * 60 * 1000;
    const UPDATE_SEEN_KEY = 'erpTpUpdateSeenVersion';
    /**
     * Пауза после нажатия «Обновить», в течение которой баннер не показываем.
     *
     * Даёт оператору время дойти до вкладки Tampermonkey, поставить версию
     * и перезагрузить ERP. Если за это время он не успел (или установка не
     * удалась), баннер вернётся — скрипт в странице всё ещё старый.
     */
    const UPDATE_SNOOZE_KEY = 'erpTpUpdateSnoozeUntil';
    const UPDATE_SNOOZE_MS = 5 * 60 * 1000;

    /**
     * Отметка «оператор ушёл ставить обновление — вернётся, надо перезагрузить».
     *
     * Зачем: Tampermonkey ставит новую версию себе, но УЖЕ ЗАПУЩЕННУЮ копию
     * скрипта в открытой вкладке не перезапускает. Страница продолжает работать
     * на старом коде, и наша же проверка честно видит «remote новее, чем
     * SELF_VERSION» — и снова показывает баннер. Оператор при этом уверен, что
     * версия уже последняя: он только что её поставил.
     *
     * Поэтому после нажатия «Обновить» ставим отметку. Когда оператор вернётся
     * на вкладку ERP (а он вернётся — установку он делал в соседней вкладке),
     * страница перезагрузится сама и подхватит новый код. Отметка живёт
     * UPDATE_RELOAD_WINDOW_MS: если человек просто отвлёкся, через десять минут
     * перезагрузка уже не сюрприз, и отметку не применяем.
     */
    const UPDATE_RELOAD_KEY = 'erpTpUpdateReloadAt';
    const UPDATE_RELOAD_WINDOW_MS = 10 * 60 * 1000;

    /**
     * Применение обновления.
     *
     * Просто открываем файл скрипта — Tampermonkey перехватывает адрес и
     * показывает свою страницу установки. Это единственный путь, который
     * работает надёжно: расширение ставит новую версию себе, а мы не пытаемся
     * подменить код в обход него.
     *
     * Почему не внедряем скачанный файл в страницу (так было в 0.71.15–0.71.19):
     * Tampermonkey выполняет скрипт в изолированной песочнице. Настоящий
     * window страницы для него — прокси, а внедрённый <script> исполняется
     * в контексте самой страницы. В итоге новая копия подменяет глобал в
     * реальном window, а песочница продолжает видеть старый — проверка версии
     * всегда проваливается, и мы уходили в запасной путь. Внешне это выглядело
     * так: нажал «Обновить» — окно исчезло, версия прежняя.
     */
    function applyUpdate() {
        updateStoreSet(UPDATE_SEEN_KEY, '');
        window.open(SELF_URL, '_blank', 'noopener');
    }

    /** Версия из строки «// @version 1.2.3» (ведущие нули и суффиксы не важны). */
    function parseVersion(text) {
        return String(text || '').trim().split(/[.\-+]/).map((p) => parseInt(p, 10) || 0);
    }

    /** true, если remote новее local. Сравнение по числам: 0.70.10 > 0.70.9. */
    function isNewerVersion(remote, local) {
        const a = parseVersion(remote);
        const b = parseVersion(local);
        const len = Math.max(a.length, b.length);
        for (let i = 0; i < len; i += 1) {
            const x = a[i] || 0;
            const y = b[i] || 0;
            if (x !== y) return x > y;
        }
        return false;
    }

    function updateStoreGet(key) {
        try { return window.localStorage.getItem(key); } catch (e) { return null; }
    }

    function updateStoreSet(key, value) {
        try { window.localStorage.setItem(key, String(value)); } catch (e) { /* приватный режим */ }
    }

    /** Версия из шапки скрипта (файл .meta.js) — тело файла читать незачем. */
    async function fetchRemoteVersion() {
        const res = await fetch(SELF_META_URL, { cache: 'no-store', credentials: 'same-origin' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        const m = text.match(/^\s*\/\/\s*@version\s+([^\s]+)/m);
        return m ? m[1] : null;
    }

    /** Снять баннер обновления и его стили (если он есть). */
    function updateBannerRemove() {
        const el = document.getElementById('tp-update-banner');
        if (el) el.remove();
        const style = document.getElementById('tp-update-style');
        if (style) style.remove();
    }

    function updateBannerMount(remoteVersion) {
        const id = 'tp-update-banner';
        if (document.getElementById(id)) return;

        const style = document.createElement('style');
        style.id = 'tp-update-style';
        style.textContent = `
            #${id} {
                position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%);
                z-index: 2147483001; display: flex; align-items: center; gap: 12px;
                max-width: min(560px, calc(100vw - 32px));
                padding: 12px 14px; border-radius: 14px;
                background: #fff; border: 1px solid rgba(0,0,0,.08);
                box-shadow: 0 2px 6px rgba(0,0,0,.06), 0 18px 50px -12px rgba(0,0,0,.32);
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, system-ui, sans-serif;
                font-size: 13px; line-height: 1.45; color: #1d1d1f; text-align: left;
            }
            #${id} * { box-sizing: border-box; }
            #${id} .tp-upd-icon {
                width: 30px; height: 30px; flex: 0 0 auto; border-radius: 9px;
                display: flex; align-items: center; justify-content: center;
                background: rgba(0,122,255,.1); color: #007aff; font-size: 16px;
            }
            #${id} .tp-upd-text { flex: 1 1 auto; min-width: 0; }
            #${id} .tp-upd-title { font-weight: 600; margin: 0 0 2px; }
            #${id} .tp-upd-sub { margin: 0; color: rgba(29,29,31,.55); font-size: 12px; }
            #${id} .tp-upd-actions { display: flex; gap: 8px; flex: 0 0 auto; }
            #${id} button {
                font: inherit; cursor: pointer; border-radius: 9px; padding: 7px 12px;
                border: 1px solid rgba(0,0,0,.1); background: #f5f5f7; color: #1d1d1f;
            }
            #${id} button.tp-upd-ok { background: #007aff; border-color: #007aff; color: #fff; font-weight: 600; }
            html[data-theme="dark"] #${id}, html[data-theme="modern-dark"] #${id} {
                background: #2c2c2e; border-color: rgba(255,255,255,.1); color: #f5f5f7;
            }
            html[data-theme="dark"] #${id} .tp-upd-sub,
            html[data-theme="modern-dark"] #${id} .tp-upd-sub { color: rgba(245,245,247,.6); }
            html[data-theme="dark"] #${id} button,
            html[data-theme="modern-dark"] #${id} button {
                background: #3a3a3c; border-color: rgba(255,255,255,.12); color: #f5f5f7;
            }
            html[data-theme="dark"] #${id} button.tp-upd-ok,
            html[data-theme="modern-dark"] #${id} button.tp-upd-ok {
                background: #0a84ff; border-color: #0a84ff; color: #fff;
            }
        `;
        (document.head || document.documentElement).appendChild(style);

        const box = document.createElement('div');
        box.id = id;

        const icon = document.createElement('div');
        icon.className = 'tp-upd-icon';
        icon.textContent = '↓';

        const text = document.createElement('div');
        text.className = 'tp-upd-text';
        const title = document.createElement('p');
        title.className = 'tp-upd-title';
        title.textContent = `Доступна новая версия ${remoteVersion}`;
        const sub = document.createElement('p');
        sub.className = 'tp-upd-sub';
        sub.textContent = `У вас ${SELF_VERSION}. Обновитесь, чтобы работать с исправлениями.`;
        text.append(title, sub);

        const actions = document.createElement('div');
        actions.className = 'tp-upd-actions';

        // «Позже» — осознанный отказ от этой версии: запоминаем её навсегда,
        // чтобы окно не всплывало на каждой странице.
        const later = document.createElement('button');
        later.type = 'button';
        later.textContent = 'Позже';
        later.addEventListener('click', () => {
            updateStoreSet(UPDATE_SEEN_KEY, remoteVersion);
            box.remove();
        });

        // «Обновить» открывает файл: Tampermonkey показывает свою страницу
        // установки. Баннер снимаем, но версию в «отложенные» НЕ пишем —
        // вместо этого ставим паузу на несколько минут.
        //
        // Почему так: раньше здесь запоминалась версия, и если установка не
        // проходила (оператор не дошёл до Tampermonkey, закрыл вкладку, ставил
        // из-под VPN), баннер пропадал навсегда, а человек продолжал работать
        // на старом коде. Теперь по истечении паузы проверка снова покажет
        // окно, если версия в браузере всё ещё старая.
        const ok = document.createElement('button');
        ok.type = 'button';
        ok.className = 'tp-upd-ok';
        ok.textContent = 'Обновить';
        ok.addEventListener('click', () => {
            updateStoreSet(UPDATE_SNOOZE_KEY, String(Date.now() + UPDATE_SNOOZE_MS));
            // Ставим отметку: когда оператор вернётся на эту вкладку после
            // установки, страница перезагрузится и подхватит новый код.
            updateStoreSet(UPDATE_RELOAD_KEY, String(Date.now()));
            box.remove();
            applyUpdate();
        });

        actions.append(later, ok);
        box.append(icon, text, actions);
        (document.body || document.documentElement).appendChild(box);
    }

    /**
     * Проверка версии.
     *
     * mode:
     *   'load'  — старт страницы: проверяем всегда, без ограничителя;
     *   'focus' — вернулись на вкладку: не чаще UPDATE_FOCUS_MIN_MS;
     *   'force' — ручной вызов из консоли: ждёт только кэш CDN.
     *
     * Ошибки сети молча игнорируем — проверка обновлений не должна мешать работе.
     */
    async function updateCheck(mode) {
        const m = mode === true ? 'force' : (mode || 'load');
        const minGap = m === 'force' ? UPDATE_CDN_MIN_MS
            : m === 'focus' ? UPDATE_FOCUS_MIN_MS
                : 0;
        const last = Number(updateStoreGet(UPDATE_CHECK_KEY)) || 0;
        const age = Date.now() - last;
        // Проверяли недавно — молчим. Показывать баннер повторно между
        // проверками нельзя: оператор уже нажал «Позже», и всплывающее
        // окно на каждой странице выглядело бы как навязчивая реклама.
        if (age < minGap) return;
        updateStoreSet(UPDATE_CHECK_KEY, Date.now());
        try {
            const remote = await fetchRemoteVersion();
            // Нет данных или версия уже не новее — обновляться нечего.
            // Висящий баннер в этом случае снимаем: он мог остаться от прошлой
            // проверки, когда версия была новее, а потом её установили.
            if (!remote || !isNewerVersion(remote, SELF_VERSION)) {
                updateBannerRemove();
                return;
            }
            // Эту версию отложили кнопкой «Позже» — больше не показываем
            if (updateStoreGet(UPDATE_SEEN_KEY) === remote) {
                updateBannerRemove();
                return;
            }
            // Нажимали «Обновить» недавно — даём время поставить версию.
            // Пауза короткая: если установка не удалась, окно вернётся.
            const snooze = Number(updateStoreGet(UPDATE_SNOOZE_KEY)) || 0;
            if (Date.now() < snooze) return;
            updateBannerMount(remote);
        } catch (e) { /* нет сети, файл недоступен — не мешаем работе */ }
    }

    /**
     * Перезагрузка страницы после установки обновления.
     *
     * Вызывается при возврате на вкладку ERP. Оператор нажимал «Обновить»,
     * уходил в соседнюю вкладку к Tampermonkey, ставил версию — и возвращался
     * сюда. Страница к этому моменту всё ещё на старом коде, поэтому её надо
     * перезагрузить: только так новый скрипт начнёт работать.
     *
     * Без этого получался замкнутый круг: версия установлена, но проверка
     * сравнивает remote с SELF_VERSION запущенной копии, видит расхождение и
     * снова показывает баннер. Оператор недоумевает — он же только что обновился.
     *
     * Отметку снимаем сразу, чтобы перезагрузка не повторялась бесконечно:
     * скрипт в новой странице стартует уже без неё.
     *
     * Возвращает true, если перезагрузка запланирована — вызывающий код в этом
     * случае не должен запускать проверку обновлений.
     */
    function maybeReloadAfterInstall() {
        const at = Number(updateStoreGet(UPDATE_RELOAD_KEY)) || 0;
        if (!at) return false;

        // Отметка старая — оператор уже не ждёт перезагрузки. Снимаем и молчим.
        if (Date.now() - at > UPDATE_RELOAD_WINDOW_MS) {
            updateStoreSet(UPDATE_RELOAD_KEY, '');
            return false;
        }

        updateStoreSet(UPDATE_RELOAD_KEY, '');
        // Небольшая пауза: даём менеджеру дописать файл, прежде чем грузить его
        setTimeout(() => { window.location.reload(); }, 400);
        return true;
    }

    /*
     * Постоянные вкладки панели задач (#taskPanel: Поиск, Radius Logs,
     * Очереди процессов и прочие) раньше восстанавливались после F5 из
     * localStorage — скрипт запоминал состав, порядок и закрепление вкладок
     * и открывал их заново через $$.shell.contentLoad.
     *
     * Функция убрана: в самом ERP панель между загрузками НЕ сохраняется,
     * и восстановление расходилось с поведением сайта — оператор видел
     * вкладки, которых «не открывал», а закрепление (удалённый крестик)
     * переживало перезагрузку. Теперь поведение совпадает с оригиналом:
     * после F5 панель пуста.
     *
     * Оставшийся снимок в localStorage чистим один раз, чтобы он не занимал
     * место и не сбивал с толку при разборе проблем.
     */
    const TASK_TABS_KEY_LEGACY = 'erpTpTaskTabs';

    function dropLegacyTaskTabs() {
        try { window.localStorage.removeItem(TASK_TABS_KEY_LEGACY); } catch (e) { /* приватный режим */ }
    }

    function waitAndInit() {
        watch();

        dropLegacyTaskTabs();

        // Отметка могла остаться с прошлой загрузки: оператор нажал «Обновить»,
        // ушёл ставить версию и вернулся уже через F5. Тогда перезагружать не
        // нужно — новый код и так запущен, — но отметку надо снять, иначе она
        // сработает позже без причины.
        const pendingReload = Number(updateStoreGet(UPDATE_RELOAD_KEY)) || 0;
        if (pendingReload) updateStoreSet(UPDATE_RELOAD_KEY, '');

        // Проверку обновлений не ставим в очередь с отрисовкой: она сетевая.
        // На старте проверяем всегда — оператор только что загрузил страницу.
        setTimeout(() => { updateCheck('load'); }, 3000);

        // Оператор может не перезагружать ERP часами, а релиз выходит днём.
        // Вернулся на вкладку — тоже повод проверить, но здесь ограничитель
        // нужен: переключение туда-обратно не должно слать запрос каждый раз.
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) return;
            // Вернулись после установки в соседней вкладке — перезагружаем
            // страницу, иначе она так и останется на старом коде, а проверка
            // обновлений продолжит показывать баннер.
            if (maybeReloadAfterInstall()) return;
            updateCheck('focus');
        });
    }

    contentBuilder = buildContent;

    /*
     * Последний договор, чью панель мы видели.
     *
     * Нужен при смене договора: history.state в момент hashchange УЖЕ
     * содержит новый адрес, поэтому «прежний» из него не достать.
     */
    let lastContractId = (location.hash || '').match(/#(\d+)/) ? (location.hash.match(/#(\d+)/) || [])[1] : '';

    window.addEventListener('hashchange', () => {
        // Договор сменили — данные ПРЕЖНЕГО договора не годятся, но кэш
        // остальных открытых карточек трогать нельзя: при трёх договорах
        // полный сброс означал ~45 запросов на каждый переход.
        const next = (location.hash || '').match(/#(\d+)/);
        const nextId = next ? next[1] : '';
        if (lastContractId && lastContractId !== nextId) {
            netDrop(new RegExp('contractId=' + lastContractId + '\\b'));
        }
        lastContractId = nextId;

        setTimeout(() => {
            // Перерисовываем только активную панель: скрытые обновятся сами,
            // когда оператор вернётся на их вкладку (refreshOnShow).
            const cards = Array.from(document.querySelectorAll('#content > div[id^="contract_bill-"]'));
            const shown = cards.filter((el) => el.offsetParent !== null);
            const host = shown.length ? shown[shown.length - 1] : null;
            const panel = host ? findPanel(host) : null;
            if (panel) applyContent(panel, contentBuilder);
        }, 600);
    });

    window.__tpInfoTab = {
        setContent,
        refresh: () => document.querySelectorAll(PANEL_SEL).forEach((p) => applyContent(p, contentBuilder)),
        reinstall: () => { try { install(); } catch (e) { /* ignore */ } },
        ERP,
        auth: {
            load: authLoad,
            save: authSave,
            clear: authClear,
            tick: () => { try { authTick(); } catch (e) { /* ignore */ } },
        },
        // Ручная проверка обновлений из консоли: __tpInfoTab.update.check(true)
        update: {
            version: SELF_VERSION,
            check: (force) => updateCheck(!!force),
        },
    };

    // Новая копия скрипта останавливает предыдущую: см. блок в начале файла.
    window.__erpTpTab.destroy = () => {
        try { teardown(); } catch (e) { /* старый «сторож» уже снят */ }
        document.querySelectorAll(PANEL_SEL).forEach((p) => p.remove());
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', waitAndInit);
    } else {
        waitAndInit();
    }
})();
