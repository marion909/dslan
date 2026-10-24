// Behaviour of the phone layout: drawer and sheet, and wide tables that scroll inside their own box.
var Mobile = {
  _toggle: function (id, on) {
    var el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle('open', on);
    el.setAttribute('aria-hidden', on ? 'false' : 'true');
    document.body.classList.toggle('m-lock', on);
  },
  drawer: function (on) { Mobile._toggle('m_drawer', on); },
  sheet: function (on) { Mobile._toggle('m_sheet', on); },
  wrapTables: function () {
    var box = document.getElementById('content_value');
    if (!box) return;
    var width = box.clientWidth;
    $('#content_value table').each(function () {
      var table = this;
      if (table.closest('.twl-scroll') || table.closest('#map_container, #map, #minimap_container')) return;
      if (table.offsetWidth <= width + 1 || $(table).find('#map_big').length) return;
      if (table.parentNode !== box && $(table).parents('table').length) return; // only outermost wide tables
      $(table).wrap('<div class="twl-scroll"></div>');
    });
  }
};
$(document).ready(function () {
  Mobile.wrapTables();
  $(window).on('resize orientationchange', function () { $('.twl-scroll > table').unwrap(); Mobile.wrapTables(); });
  $(document).on('keydown', function (e) { if (e.which === 27) { Mobile.drawer(false); Mobile.sheet(false); } });
});
