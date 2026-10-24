/*
 * 09 — during the parallel week index.html keeps its own copy of the holdings and renders from it.
 * Two copies of one truth WILL drift unless a gate fails on the first divergence. Guard: validate-all
 * compares every id/ticker/qty/book/manual mark of book.json against the {id:N,…} literals.
 */
module.exports = {
  name: '09-book-drift', incident: 'phase 1 — book.json and index.html are two copies of one truth',
  run(ctx) {
    const h = ctx.read('book.json').holdings.find(x => x.id === 1);
    ctx.check('precondition: book.json id 1 is D05 with qty 3000', h && h.t === 'D05' && h.qty === 3000, JSON.stringify(h));
    ctx.edit('book.json', b => { b.holdings.find(x => x.id === 1).qty = 3100; });
    ctx.expect('qty 3000 → 3100 on id 1', ctx.validateAll(), { exit: [1], problems: [/^book\.json: DRIFT vs index\.html — id 1 D05: qty book\.json=3100 html=3000/], notPassed: [/^book: \d+ holdings match/] });
    ctx.edit('book.json', b => { b.holdings.find(x => x.id === 1).qty = 3000; b.holdings.push({ id: 999, n: 'Fixture Corp', t: 'FXT', yf: null, ac: 'Equity', region: 'Global', cur: 'USD', qty: 1, book: 1, valued: 'live' }); });
    ctx.expect('a holding only in book.json', ctx.validateAll(), { exit: [1], problems: [/^book\.json: DRIFT vs index\.html — id 999 \(FXT\) in book\.json but not in index\.html/] });
  },
};
