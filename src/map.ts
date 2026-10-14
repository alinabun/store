// Delivery pin picker. Leaflet (~45 KB) loads from cdnjs only on the order form;
// tiles: OpenStreetMap (street map) or Esri (satellite). Both need the attribution shown.
const LEAFLET = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/";
const MALE: [number, number] = [4.1755, 73.5093];

export interface Pin { lat: number; lng: number }

function loadLeaflet(): Promise<void> {
  const css = Object.assign(document.createElement("link"), { rel: "stylesheet", href: LEAFLET + "leaflet.min.css" });
  document.head.append(css);
  return new Promise((ok, fail) => {
    const s = Object.assign(document.createElement("script"), { src: LEAFLET + "leaflet.min.js", onload: () => ok(), onerror: fail });
    document.head.append(s);
  });
}

/** Tap to drop a pin, drag to move it. Shows the customer's own location as a blue dot when they allow it. */
export async function pinPicker(el: HTMLElement, initial: Pin | null, onChange: (p: Pin) => void) {
  await loadLeaflet();
  // deno-lint-ignore no-explicit-any
  const L = (window as any).L;
  L.Icon.Default.imagePath = LEAFLET + "images/";
  const streets = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  });
  const satellite = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 19, attribution: "Imagery © Esri",
  });
  const map = L.map(el, { layers: [streets] }).setView(initial ? [initial.lat, initial.lng] : MALE, initial ? 17 : 14);
  L.control.layers({ Map: streets, Satellite: satellite }, undefined, { collapsed: false }).addTo(map);

  // deno-lint-ignore no-explicit-any
  let marker: any = null;
  const emit = () => onChange(marker.getLatLng());
  const place = (ll: Pin, silent = false) => {
    if (marker) marker.setLatLng(ll);
    else marker = L.marker(ll, { draggable: true, autoPan: true }).addTo(map).on("dragend", emit);
    if (!silent) emit();
  };
  if (initial) place(initial, true); // the caller already holds it
  map.on("click", (e: { latlng: Pin }) => place(e.latlng));

  // Ask for the location only once the map is on screen, so the permission prompt makes sense.
  new IntersectionObserver((entries, obs) => {
    if (!entries[0].isIntersecting) return;
    obs.disconnect();
    navigator.geolocation?.getCurrentPosition((p) => {
      const ll = [p.coords.latitude, p.coords.longitude];
      L.circle(ll, { radius: p.coords.accuracy, weight: 1, color: "#2a7fff", fillOpacity: 0.1, interactive: false }).addTo(map);
      L.circleMarker(ll, { radius: 7, color: "#fff", weight: 2, fillColor: "#2a7fff", fillOpacity: 1, interactive: false }).addTo(map);
      if (!marker) map.setView(ll, 17);
    }, () => {}, { enableHighAccuracy: true, timeout: 15_000, maximumAge: 60_000 });
  }).observe(el);
}
