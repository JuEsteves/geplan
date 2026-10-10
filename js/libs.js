// Bibliotecas externas carregadas sob demanda (ficam em cache para uso offline depois do 1º uso).
export const LIBS = {
  xlsx: 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
  jspdf: 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  autotable: 'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js',
};

const loaded = {};
export function loadScript(src) {
  if (!loaded[src]) {
    loaded[src] = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.onload = res;
      s.onerror = () => { delete loaded[src]; rej(new Error('Não foi possível carregar a biblioteca (verifique a internet).')); };
      document.head.appendChild(s);
    });
  }
  return loaded[src];
}
