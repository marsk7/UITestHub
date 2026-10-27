import { locatorExpression, locatorFromSpec } from './locator-evidence.mjs';

// DOM-derived paths are observed addresses, never model-supplied executable code.
export async function collectComponents(page, frame, framePath, frameIndex) {
    const descriptors = await frame.locator('body').evaluate(body => {
        const visible = e => !!e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden' && getComputedStyle(e).display !== 'none';
        const text = e => (e?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200);
        const path = e => { if (e.id) return '[id=' + JSON.stringify(e.id) + ']'; const parts = []; for (let n = e; n && n !== body; n = n.parentElement) { if (n.id) { parts.unshift('[id=' + JSON.stringify(n.id) + ']'); break; } parts.unshift(n.tagName.toLowerCase() + ':nth-of-type(' + ([...n.parentElement.children].filter(x => x.tagName === n.tagName).indexOf(n) + 1) + ')'); } return parts.join(' > '); };
        const out = []; const add = (el, kind, extra = {}) => out.push({ selector: path(el), kind, nameHint: text(el), ...extra });
        for (const select of [...body.querySelectorAll('.ant-select')].filter(visible).slice(0, 30)) {
            const input = select.querySelector('[role=combobox]'); const owner = input?.id || input?.getAttribute('aria-label') || '';
            for (const value of select.querySelectorAll('.ant-select-selection-item')) if (visible(value)) add(value, 'selected-value', { owner });
            const carrier = select.querySelector('.ant-select-selector') || select; const selectedText = [...select.querySelectorAll('.ant-select-selection-item')].map(text).join(' ');
            if (visible(carrier)) add(carrier, 'selected-value', { owner, carrier: 'selection-container', selectedText, emptySelection: !selectedText, readStrategy: '使用容器的可重试文本断言验证选择后的回显；输入框搜索文字不是已选值' });
            const popupId = input?.getAttribute('aria-controls') || input?.getAttribute('aria-owns');
            const list = popupId && document.getElementById(popupId); const popup = list?.closest('.ant-select-dropdown');
            if (popup && visible(popup)) add(popup, 'select-popup', { owner, ownerSelector: input ? path(input) : null });
        }
        for (const popup of [...body.querySelectorAll('.ant-select-dropdown')].filter(visible).slice(0, 10)) {
            if (!out.some(x => x.kind === 'select-popup' && x.selector === path(popup))) add(popup, 'select-popup');
            for (const opt of popup.querySelectorAll('.ant-select-item-option')) if (visible(opt)) add(opt, 'select-option', { nameHint: text(opt.querySelector('.ant-select-item-option-content') || opt), disabled: opt.classList.contains('ant-select-item-option-disabled'), popupSelector: path(popup) });
            for (const holder of popup.querySelectorAll('.rc-virtual-list-holder')) if (visible(holder) && holder.scrollHeight > holder.clientHeight) add(holder, 'virtual-list', { popupSelector: path(popup), scrollTop: holder.scrollTop, scrollHeight: holder.scrollHeight, clientHeight: holder.clientHeight });
        }
        for (const table of [...body.querySelectorAll('table,[role=grid]')].filter(visible).slice(0, 5)) {
            const selector = path(table); const headerRoot = table.querySelector('thead th,[role=columnheader]') ? table : (table.closest('.ant-table') || table); const headers = [...headerRoot.querySelectorAll('thead th,[role=columnheader]')].map((el, index) => ({ index, name: text(el), selector: path(el), colSpan: el.colSpan || 1, rowSpan: el.rowSpan || 1 }));
            const rows = [...table.querySelectorAll('tbody > tr,[role=row]')].filter(r => visible(r) && r.querySelector('td,[role=gridcell]') && !r.matches('.ant-table-measure-row,.ant-table-placeholder'));
            add(table, 'table', { headers, columnMappingReliable: headers.length > 0 && headers.every(h => h.colSpan === 1 && h.rowSpan === 1) && rows.slice(0, 3).every(r => r.querySelectorAll('td,[role=gridcell]').length === headers.length), rowsSelector: selector + ' ' + (table.matches('[role=grid]') ? '[role=row]:has([role=gridcell])' : 'tbody > tr:not(.ant-table-measure-row):not(.ant-table-placeholder)'), visibleRowCount: rows.length, sampleOnly: true, rows: rows.slice(0, 3).map(r => [...r.querySelectorAll('td,[role=gridcell]')].map(text)) });
        }
        for (const pagination of [...body.querySelectorAll('.ant-pagination,[role=navigation][aria-label*=agin],.el-pagination')].filter(visible).slice(0, 10)) {
            add(pagination, 'pagination');
            for (const el of pagination.querySelectorAll('.ant-pagination-total-text,.el-pagination__total')) if (visible(el)) add(el, 'pagination-total', { rawText: text(el), totalSource: 'rendered-summary' });
            for (const el of pagination.querySelectorAll('.ant-pagination-item-active,[aria-current=page]')) if (visible(el)) add(el, 'current-page');
            for (const el of pagination.querySelectorAll('.ant-pagination-next,.ant-pagination-prev,.btn-next,.btn-prev')) if (visible(el)) add(el, 'page-navigation', { disabled: el.classList.contains('ant-pagination-disabled') || el.getAttribute('aria-disabled') === 'true' || !!el.disabled, direction: el.matches('.ant-pagination-next,.btn-next') ? 'next' : 'previous' });
            for (const el of pagination.querySelectorAll('.ant-select-selection-item,[aria-label="Page Size"],input')) if (visible(el)) add(el, 'page-size', { value: el.value || text(el) });
        }
        return out;
    }).catch(() => []);
    const controls = [], tables = [];
    for (const d of descriptors) {
        if (d.kind === 'pagination-total') { const m = d.rawText.match(/(?:\d+\s*[-–]\s*\d+\s+of\s+(\d+)\s*(?:items?|条)|共\s*(\d+)\s*条)/i); d.total = m ? Number(m[1] || m[2]) : null; }
        const spec = { frames: framePath || [], method: 'locator', arg: d.selector, visibleOnly: true };
        const locator = framePath === null ? frame.locator(d.selector).filter({ visible: true }) : locatorFromSpec(page, spec);
        const count = await locator.count(), visibleCount = count;
        const candidate = { expression: locatorExpression(spec), spec, count, visibleCount, visible: count > 0, frameVerified: framePath !== null, kind: 'single' };
        const control = { ...d, tag: 'component', role: d.kind === 'select-option' ? 'option' : d.kind, frameIndex, framePath, visible: count > 0, candidates: [candidate], usable: framePath !== null && count === 1 && !d.disabled };
        controls.push(control);
        if (d.kind === 'table') {
            const rowSpec = { frames: framePath || [], method: 'locator', arg: d.rowsSelector, visibleOnly: true };
            const rowCount = await (framePath === null ? frame.locator(d.rowsSelector).filter({ visible: true }) : locatorFromSpec(page, rowSpec)).count();
            const rowsCandidate = { expression: locatorExpression(rowSpec), spec: rowSpec, count: rowCount, visibleCount: rowCount, visible: rowCount > 0, frameVerified: framePath !== null, kind: 'collection' };
            const columns = [];
            for (const header of d.columnMappingReliable ? d.headers : []) {
                const headerSpec = { frames: framePath || [], method: 'locator', arg: header.selector, visibleOnly: true }; const headerCount = await (framePath === null ? frame.locator(header.selector).filter({ visible: true }) : locatorFromSpec(page, headerSpec)).count();
                const headerCandidate = { expression: locatorExpression(headerSpec), spec: headerSpec, count: headerCount, visibleCount: headerCount, visible: headerCount > 0, frameVerified: framePath !== null, kind: 'single' };
                controls.push({ tag: 'component', role: 'columnheader', kind: 'table-header', nameHint: header.name, frameIndex, framePath, visible: headerCount > 0, usable: framePath !== null && headerCount === 1, candidates: [headerCandidate] });
                // Column index is derived from the observed header order, not guessed from text samples.
                const cellSpec = { ...rowSpec, arg: d.rowsSelector + ' > ' + (d.rowsSelector.includes('[role=row]') ? '[role=gridcell]' : 'td') + ':nth-child(' + (header.index + 1) + ')' };
                const cells = framePath === null ? frame.locator(cellSpec.arg).filter({ visible: true }) : locatorFromSpec(page, cellSpec); const n = await cells.count();
                const c = { expression: locatorExpression(cellSpec), spec: cellSpec, count: n, visibleCount: n, visible: n > 0, frameVerified: framePath !== null, kind: 'collection' };
                columns.push({ ...header, headerCandidate, candidate: c }); controls.push({ tag: 'component', role: 'cells', kind: 'table-column', nameHint: header.name, frameIndex, framePath, visible: n > 0, usable: framePath !== null && n > 0, candidates: [c] });
            }
            controls.push({ tag: 'component', role: 'rows', kind: 'table-rows', nameHint: '数据行集合', frameIndex, framePath, visible: rowCount > 0, usable: framePath !== null && rowCount > 0, candidates: [rowsCandidate] });
            tables.push({ ...d, frameIndex, framePath, container: candidate, rowCandidate: rowsCandidate, columns, sampledRowCount: d.rows.length, totalRows: null, totalSource: 'unknown' });
        }
    }
    return { controls, tables };
}
