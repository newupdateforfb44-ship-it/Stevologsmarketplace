// Updates — admin tab. Separate file: works with the admin page's own helpers (aFetch, aFetchUpload, setFb, currentRole).
(function () {
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  var editId = '';
  var items = [];

  function isStaff() { return typeof currentRole !== 'undefined' && currentRole === 'staff'; }

  window.upToggle = function () {
    var tut = $('upMode').value === 'tutorial_only';
    $('upDeliveryWrap').style.display = tut ? 'none' : 'block';
    var dt = $('upDelType').value;
    $('upLinkWrap').style.display = (!tut && dt === 'link') ? 'block' : 'none';
    $('upFileWrap').style.display = (!tut && (dt === 'file' || dt === 'video' || dt === 'image')) ? 'block' : 'none';
    $('upEmailWrap').style.display = (!tut && dt === 'email') ? 'block' : 'none';
    $('upDelFile').accept = dt === 'video' ? 'video/*' : dt === 'image' ? 'image/*' : '';
    $('upFileLabel').textContent = dt === 'video' ? 'Video to deliver *' : dt === 'image' ? 'Picture to deliver *' : 'File to deliver *';
    var t = $('upTutType').value;
    $('upTutImgWrap').style.display = t === 'images' ? 'block' : 'none';
    $('upTutVidWrap').style.display = t === 'video' ? 'block' : 'none';
    $('upTutLinkWrap').style.display = t === 'link' ? 'block' : 'none';
    $('upTutNoteWrap').style.display = t !== 'none' ? 'block' : 'none';
  };

  window.upApplyQty = function () {
    var v = $('upQtyPreset').value;
    if (v !== 'custom') $('upQty').value = v;
  };
  function syncQty(q) {
    var v = String(q || 0);
    $('upQtyPreset').value = ['0', '1', '500'].indexOf(v) >= 0 ? v : 'custom';
  }

  // Support staff can add updates, but cannot change price, quantity or visibility afterwards.
  function staffLock() {
    var lock = isStaff() && !!editId;
    ['upPrice', 'upQtyPreset', 'upQty', 'upAvail'].forEach(function (id) { if ($(id)) $(id).disabled = lock; });
    $('upAvailWrap').style.display = isStaff() ? 'none' : 'block';
  }

  window.upReset = function () {
    editId = '';
    ['upTitle', 'upDesc', 'upPrice', 'upLink', 'upEmail', 'upMsg', 'upTutLink', 'upTutNote'].forEach(function (id) { $(id).value = ''; });
    $('upQty').value = '0';
    $('upQtyPreset').value = '0';
    $('upMode').value = 'product';
    $('upDelType').value = 'link';
    $('upTutType').value = 'none';
    $('upAvail').value = 'true';
    ['upPic', 'upWorking', 'upDelFile', 'upAudio', 'upTutImages', 'upTutVideo'].forEach(function (id) { $(id).value = ''; });
    ['upClearWorking', 'upClearAudio'].forEach(function (id) { $(id).checked = false; });
    $('upWorkingCur').textContent = '';
    $('upAudioCur').textContent = '';
    $('upFormTitle').textContent = 'Add an update';
    $('upCancelBtn').style.display = 'none';
    upToggle();
    staffLock();
  };

  window.upEdit = function (id) {
    var u = items.find(function (x) { return x.id === id; });
    if (!u) return;
    editId = id;
    var pt = u.purchaseTutorial || {};
    $('upTitle').value = u.title || '';
    $('upDesc').value = u.description || '';
    $('upPrice').value = u.price;
    $('upQty').value = u.qty || 0;
    syncQty(u.qty);
    $('upMode').value = u.productMode === 'tutorial_only' ? 'tutorial_only' : 'product';
    $('upDelType').value = (u.deliveryType && u.deliveryType !== 'none') ? u.deliveryType : 'link';
    $('upLink').value = u.toolLink || '';
    $('upEmail').value = u.details || '';
    $('upMsg').value = u.postPurchaseMessage || '';
    $('upTutType').value = pt.tutorialType || 'none';
    $('upTutLink').value = pt.tutorialType === 'link' ? (pt.linkUrl || '') : '';
    $('upTutNote').value = pt.note || '';
    $('upAvail').value = u.available ? 'true' : 'false';
    $('upWorkingCur').textContent = (u.workingPictures || []).length ? (u.workingPictures.length + ' picture(s) shown now. Choose new ones to add more.') : 'No working pictures yet.';
    $('upAudioCur').textContent = u.audioManual ? 'An audio manual is set. Choose a new file to replace it.' : 'No audio manual yet.';
    $('upFormTitle').textContent = 'Edit: ' + (u.title || '');
    $('upCancelBtn').style.display = 'inline-block';
    upToggle();
    staffLock();
    $('upFormTitle').scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  window.upSave = async function () {
    var fb = $('upFb');
    var title = $('upTitle').value.trim();
    if (!title) return setFb(fb, 'Name is required', 'err');
    var price = $('upPrice').value;
    if (!editId && (price === '' || Number(price) < 0)) return setFb(fb, 'Price is required', 'err');
    var fd = new FormData();
    fd.append('title', title);
    fd.append('description', $('upDesc').value);
    fd.append('productMode', $('upMode').value);
    fd.append('deliveryType', $('upMode').value === 'tutorial_only' ? 'none' : $('upDelType').value);
    fd.append('toolLink', $('upLink').value);
    fd.append('details', $('upEmail').value);
    fd.append('postPurchaseMessage', $('upMsg').value);
    fd.append('tutType', $('upTutType').value);
    fd.append('tutLink', $('upTutLink').value);
    fd.append('tutNote', $('upTutNote').value);
    if (!(isStaff() && editId)) {
      if (price !== '') fd.append('price', price);
      fd.append('qty', $('upQty').value || '0');
      fd.append('available', $('upAvail').value);
    }
    var pic = $('upPic').files[0]; if (pic) fd.append('picture', pic);
    Array.from($('upWorking').files).forEach(function (f) { fd.append('workingPictures', f); });
    if ($('upClearWorking').checked) fd.append('clearWorkingPictures', 'true');
    var af = $('upAudio').files[0]; if (af) fd.append('audioManual', af);
    if ($('upClearAudio').checked) fd.append('clearAudioManual', 'true');
    var df = $('upDelFile').files[0]; if (df) fd.append('deliverableFile', df);
    Array.from($('upTutImages').files).forEach(function (f) { fd.append('purchaseTutorialImages', f); });
    var tv = $('upTutVideo').files[0]; if (tv) fd.append('purchaseTutorialVideo', tv);
    try {
      setFb(fb, 'Saving…', '');
      if (editId) await aFetchUpload('/api/admin/updates/' + editId, 'PUT', fd, function () {});
      else await aFetchUpload('/api/admin/updates', 'POST', fd, function () {});
      setFb(fb, 'Saved!', 'ok');
      window.upReset();
      window.loadAdminUpdates();
    } catch (e) { setFb(fb, e.message, 'err'); }
  };

  window.loadAdminUpdates = async function () {
    var el = $('upList');
    try { items = await aFetch('/api/admin/updates'); }
    catch (e) { el.textContent = e.message; return; }
    if (!items.length) { el.innerHTML = '<div class="item-card-loading" style="color:var(--t2)">No updates yet</div>'; return; }
    el.innerHTML = items.map(function (u) {
      var stock = u.qty > 0 ? ((u.qty - (u.soldCount || 0)) + ' left of ' + u.qty) : 'Unlimited';
      var type = u.productMode === 'tutorial_only' ? 'Tutorial only' : ('Product · ' + esc(u.deliveryType));
      return '<div class="item-card"><div class="item-card-body">' +
        '<div class="item-card-title">' + esc(u.title) + '</div>' +
        '<div class="item-card-fields">' +
        '<div class="item-card-field"><span class="item-card-field-label">Price</span><span class="item-card-field-val">₦' + Number(u.price || 0).toLocaleString('en-NG') + '</span></div>' +
        '<div class="item-card-field"><span class="item-card-field-label">Stock</span><span class="item-card-field-val">' + stock + '</span></div>' +
        '<div class="item-card-field"><span class="item-card-field-label">Sold</span><span class="item-card-field-val">' + (u.soldCount || 0) + '</span></div>' +
        '<div class="item-card-field"><span class="item-card-field-label">Type</span><span class="item-card-field-val">' + type + '</span></div>' +
        '<div class="item-card-field"><span class="item-card-field-label">Shown</span><span class="item-card-field-val">' + (u.available ? 'Yes' : 'No') + '</span></div>' +
        '</div><div class="item-card-actions">' +
        '<button class="btn-edit" onclick="upEdit(\'' + u.id + '\')">Edit</button>' +
        (isStaff() ? '' : '<button class="btn-del" onclick="upDelete(\'' + u.id + '\')">Delete</button>') +
        '</div></div></div>';
    }).join('');
  };

  window.upDelete = async function (id) {
    if (!confirm('Delete this update? This cannot be undone.')) return;
    try { await aFetch('/api/admin/updates/' + id, 'DELETE'); window.loadAdminUpdates(); }
    catch (e) { alert(e.message); }
  };

  // Load the list whenever the Updates tab is opened.
  var _switch = window.switchTab;
  if (typeof _switch === 'function') {
    window.switchTab = function (name, el) {
      var r = _switch.apply(this, arguments);
      if (name === 'updates') window.loadAdminUpdates();
      return r;
    };
  }

  upToggle();
  staffLock();
})();
