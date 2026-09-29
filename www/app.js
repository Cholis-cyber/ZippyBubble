/* ============================================================
   ZippyBubble — app.js
   Kompres & Ekstrak ZIP 100% Offline (Vanilla JS ES6+)
   - Optimized untuk perangkat low-end (RAM 4GB)
   - Anti memory-leak: revoke ObjectURL, lepas referensi ZIP,
     event delegation, render dengan DocumentFragment,
     dan unduhan file LAZY (dekompresi hanya saat diminta)
   ============================================================ */

"use strict";

/* ------------------ KONSTANTA KATEGORI ------------------ */
const DEFINISI_KATEGORI = {
  gambar: {
    label: "Gambar",
    ekstensi: ["jpg", "jpeg", "png", "gif", "webp"]
  },
  dokumen: {
    label: "Dokumen",
    ekstensi: ["pdf", "doc", "docx", "txt", "xlsx", "pptx"]
  },
  media: {
    label: "Media",
    ekstensi: ["mp3", "wav", "mp4", "mkv", "avi"]
  }
};

/* Ikon Material Icons Round untuk tiap kategori (termasuk "lainnya") */
const IKON_KATEGORI = {
  gambar: "image",
  dokumen: "description",
  media: "movie",
  lainnya: "insert_drive_file"
};

/* Kelas CSS chip warna untuk tiap kategori */
const CHIP_KELAS = {
  gambar: "chip-gambar",
  dokumen: "chip-dokumen",
  media: "chip-media",
  lainnya: "chip-lainnya"
};

/* CDN JSZip — dipakai HANYA jika pustaka lokal gagal dimuat (mode browser) */
const CDN_JSZIP = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";

/* ------------------ STATE APLIKASI ------------------ */
let daftarFileTerpilih = [];  // File yang akan dikompres
let hasilEkstrak = [];        // Metadata file hasil ekstraksi
let zipAktif = null;          // Instance JSZip yang sedang aktif
let kategoriAktif = "semua";  // Tab kategori yang sedang dibuka
let sedangProses = false;     // Kunci anti double-process

/* ------------------ CACHE ELEMEN DOM ------------------ */
const $ = (id) => document.getElementById(id);

const el = {
  inputCompress: $("inputCompress"),
  compressList: $("compressList"),
  compressMeta: $("compressMeta"),
  btnCompress: $("btnCompress"),
  compressProgressWrap: $("compressProgressWrap"),
  compressProgressBar: $("compressProgressBar"),
  compressProgressText: $("compressProgressText"),

  inputExtract: $("inputExtract"),
  extractLabel: $("extractLabel"),
  btnExtract: $("btnExtract"),
  extractProgressWrap: $("extractProgressWrap"),
  extractProgressBar: $("extractProgressBar"),
  extractProgressText: $("extractProgressText"),

  resultSection: $("resultSection"),
  bentoTiles: Array.from(document.querySelectorAll(".bento-tile")),
  countGambar: $("countGambar"),
  countDokumen: $("countDokumen"),
  countMedia: $("countMedia"),
  countUnduhan: $("countUnduhan"),

  listTitle: $("listTitle"),
  listCount: $("listCount"),
  extractList: $("extractList"),
  emptyList: $("emptyList"),
  btnBersihkan: $("btnBersihkan"),

  toastWrap: $("toastWrap")
};

/* ------------------ UTILITAS UMUM ------------------ */

/* Memuat JSZip dari CDN bila pustaka lokal tidak ditemukan (fallback browser) */
function muatJSZip() {
  return new Promise((resolve, reject) => {
    if (window.JSZip) {
      resolve();
      return;
    }
    buatToast("Pustaka lokal tidak ada — memuat JSZip dari CDN...", "info");
    const script = document.createElement("script");
    script.src = CDN_JSZIP;
    script.onload = () => resolve();
    script.onerror = () =>
      reject(new Error("JSZip gagal dimuat. Periksa file lokal atau koneksi."));
    document.head.appendChild(script);
  });
}

/* Format ukuran byte menjadi teks yang mudah dibaca */
function formatUkuran(byte) {
  if (!byte || byte <= 0) return "—";
  const satuan = ["B", "KB", "MB", "GB"];
  let nilai = byte;
  let i = 0;
  while (nilai >= 1024 && i < satuan.length - 1) {
    nilai /= 1024;
    i += 1;
  }
  const teks = i === 0 || nilai >= 10 ? Math.round(nilai).toString() : nilai.toFixed(1);
  return `${teks} ${satuan[i]}`;
}

/* Ambil nama file saja dari sebuah path (mendukung / dan \) */
function ambilBasename(path) {
  const bersih = String(path).replace(/\\/g, "/");
  const potongan = bersih.split("/").filter(Boolean);
  return potongan.length ? potongan[potongan.length - 1] : String(path);
}

/* Ambil ekstensi (huruf kecil) dari sebuah nama/alamat file */
function ambilEkstensi(nama) {
  const base = ambilBasename(nama);
  const titik = base.lastIndexOf(".");
  if (titik < 0 || titik === base.length - 1) return "";
  return base.slice(titik + 1).toLowerCase();
}

/* Klasifikasi otomatis berdasarkan ekstensi */
function klasifikasiFile(nama) {
  const ext = ambilEkstensi(nama);
  const kunci = Object.keys(DEFINISI_KATEGORI);
  for (let i = 0; i < kunci.length; i += 1) {
    if (DEFINISI_KATEGORI[kunci[i]].ekstensi.indexOf(ext) !== -1) {
      return kunci[i];
    }
  }
  return "lainnya";
}

/* Pastikan nama file unik di dalam arsip (hindari file saling timpa) */
function namaUnik(nama, setDipakai) {
  if (!setDipakai.has(nama)) {
    setDipakai.add(nama);
    return nama;
  }
  const titik = nama.lastIndexOf(".");
  const dasar = titik > 0 ? nama.slice(0, titik) : nama;
  const ekst = titik > 0 ? nama.slice(titik) : "";
  let hitung = 1;
  let kandidat = `${dasar} (1)${ekst}`;
  while (setDipakai.has(kandidat)) {
    hitung += 1;
    kandidat = `${dasar} (${hitung})${ekst}`;
  }
  setDipakai.add(kandidat);
  return kandidat;
}

/* Sanitasi nama file untuk atribut download */
function sanitasiNamaFile(nama) {
  const bersih = nama.replace(/[\\/:*?"<>|]/g, "_").trim();
  return bersih || "file";
}

/* Baca ukuran asli entry dari metadata internal JSZip (tanpa dekompresi = hemat memori) */
function ukuranEntry(entry) {
  try {
    if (entry && entry._data && typeof entry._data.uncompressedSize === "number") {
      return entry._data.uncompressedSize;
    }
  } catch (e) {
    /* diamkan — ukuran hanya bersifat informasional */
  }
  return 0;
}

/* Lepas semua referensi arsip lama agar garbage collector bekerja */
function lepaskanZipLama() {
  zipAktif = null;
  hasilEkstrak = [];
}

/* ------------------ TOAST NOTIFIKASI ------------------ */
function buatToast(pesan, tipe = "info") {
  const ikon = tipe === "sukses" ? "check_circle" : tipe === "gagal" ? "error" : "info";
  const toast = document.createElement("div");
  toast.className = `toast toast-${tipe}`;

  const ic = document.createElement("span");
  ic.className = "material-icons-round";
  ic.textContent = ikon;

  const teks = document.createElement("span");
  teks.textContent = pesan;

  toast.append(ic, teks);
  el.toastWrap.appendChild(toast);

  requestAnimationFrame(() => toast.classList.add("tampil"));

  setTimeout(() => {
    toast.classList.remove("tampil");
    setTimeout(() => toast.remove(), 350);
  }, 2800);
}

/* ------------------ PROGRESS BAR ------------------ */
function mulaiProgress(wrap, bar, teks) {
  wrap.hidden = false;
  wrap.dataset.last = "-1";
  bar.classList.remove("tak-tentu");
  bar.style.width = "0%";
  teks.textContent = "0%";
}

function setProgress(wrap, bar, teks, persen) {
  const nilai = Math.max(0, Math.min(100, Math.round(persen)));
  if (String(nilai) === wrap.dataset.last) return; /* hemat repaint DOM */
  wrap.dataset.last = String(nilai);
  bar.style.width = `${nilai}%`;
  teks.textContent = `${nilai}%`;
}

function mulaiProgressTidakTentu(wrap, bar, teks) {
  wrap.hidden = false;
  wrap.dataset.last = "-1";
  bar.classList.add("tak-tentu");
  bar.style.width = "38%";
  teks.textContent = "Membuka…";
}

function selesaiProgress(wrap, bar) {
  bar.classList.remove("tak-tentu");
  bar.style.width = "0%";
  wrap.dataset.last = "-1";
  wrap.hidden = true;
}

/* ------------------ STATUS TOMBOL ------------------ */
function aturStatusTombol() {
  const adaZip = el.inputExtract.files && el.inputExtract.files.length > 0;
  el.btnCompress.disabled = sedangProses || daftarFileTerpilih.length === 0;
  el.btnExtract.disabled = sedangProses || !adaZip;
}

/* ------------------ UNDUH BLOB ------------------ */
/* Memicu unduhan lokal dari sebuah Blob lalu melepas URL memori (anti leak) */
function unduhBlob(blob, namaFile) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const tautan = document.createElement("a");
    tautan.href = url;
    tautan.download = namaFile;
    document.body.appendChild(tautan);
    tautan.click();
    tautan.remove();
    setTimeout(() => {
      URL.revokeObjectURL(url); /* WAJIB! mencegah memory leak */
      resolve();
    }, 1500);
  });
}

/* Unduh satu file dari arsip aktif (LAZY: dekompresi baru terjadi saat diminta) */
async function unduhFile(path) {
  if (!zipAktif) {
    buatToast("Arsip sudah dibersihkan — ekstrak ulang ZIP-nya.", "gagal");
    return;
  }
  const entry = zipAktif.file(path);
  if (!entry) {
    buatToast("File tidak ditemukan di dalam arsip.", "gagal");
    return;
  }
  try {
    const blob = await entry.async("blob");
    const namaAman = sanitasiNamaFile(ambilBasename(path));
    await unduhBlob(blob, namaAman);
    buatToast(`"${namaAman}" berhasil diunduh.`, "sukses");
  } catch (err) {
    console.error("Gagal mengunduh:", err);
    buatToast("Gagal mengunduh file dari arsip.", "gagal");
  }
}

/* ------------------ RENDER: DAFTAR KOMPRES ------------------ */
function renderDaftarKompres() {
  el.compressList.textContent = "";

  daftarFileTerpilih.forEach((file, index) => {
    const kategori = klasifikasiFile(file.name);

    const li = document.createElement("li");
    li.className = "file-item";

    const chip = document.createElement("span");
    chip.className = `file-chip ${CHIP_KELAS[kategori]}`;
    const ic = document.createElement("span");
    ic.className = "material-icons-round";
    ic.textContent = IKON_KATEGORI[kategori];
    chip.appendChild(ic);

    const info = document.createElement("div");
    info.className = "file-info";
    const nama = document.createElement("strong");
    nama.textContent = file.name;
    const meta = document.createElement("small");
    meta.textContent = formatUkuran(file.size);
    info.append(nama, meta);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn-hapus";
    btn.dataset.index = String(index);
    btn.setAttribute("aria-label", `Hapus ${file.name} dari daftar`);
    const ic2 = document.createElement("span");
    ic2.className = "material-icons-round";
    ic2.textContent = "close";
    btn.appendChild(ic2);

    li.append(chip, info, btn);
    el.compressList.appendChild(li);
  });

  if (!daftarFileTerpilih.length) {
    el.compressMeta.textContent = "Belum ada file dipilih";
  } else {
    const total = daftarFileTerpilih.reduce((acc, f) => acc + (f.size || 0), 0);
    el.compressMeta.textContent = `${daftarFileTerpilih.length} file dipilih • total ${formatUkuran(total)}`;
  }

  aturStatusTombol();
}

/* ------------------ RENDER: BENTO + DAFTAR EKSTRAK ------------------ */
function perbaruiBento() {
  const hitung = { gambar: 0, dokumen: 0, media: 0, lainnya: 0 };
  for (const f of hasilEkstrak) {
    hitung[f.kategori] += 1;
  }
  el.countGambar.textContent = String(hitung.gambar);
  el.countDokumen.textContent = String(hitung.dokumen);
  el.countMedia.textContent = String(hitung.media);
  el.countUnduhan.textContent = String(hasilEkstrak.length);

  el.bentoTiles.forEach((tile) => {
    tile.classList.toggle("aktif", tile.dataset.cat === kategoriAktif);
  });
}

function renderDaftarEkstrak() {
  const daftar = kategoriAktif === "semua"
    ? hasilEkstrak
    : hasilEkstrak.filter((f) => f.kategori === kategoriAktif);

  el.listTitle.textContent = kategoriAktif === "semua"
    ? "Unduhan — Semua File"
    : DEFINISI_KATEGORI[kategoriAktif].label;
  el.listCount.textContent = `${daftar.length} file`;

  /* Bersihkan list lama sekaligus (mencegah node DOM menumpuk di memori) */
  el.extractList.textContent = "";

  const kosong = daftar.length === 0;
  el.extractList.hidden = kosong;
  el.emptyList.hidden = !kosong;
  if (kosong) return;

  /* DocumentFragment: dirender sekali tempel (hemat reflow, ramah low-end) */
  const fragmen = document.createDocumentFragment();

  daftar.forEach((file) => {
    const li = document.createElement("li");
    li.className = "file-item";

    const chip = document.createElement("span");
    chip.className = `file-chip ${CHIP_KELAS[file.kategori]}`;
    const ic = document.createElement("span");
    ic.className = "material-icons-round";
    ic.textContent = IKON_KATEGORI[file.kategori];
    chip.appendChild(ic);

    const info = document.createElement("div");
    info.className = "file-info";
    const nama = document.createElement("strong");
    nama.textContent = file.nama;
    nama.title = file.path; /* tampilkan path lengkap saat disentuh lama */
    const meta = document.createElement("small");
    const labelKat = file.kategori === "lainnya" ? "Lainnya" : DEFINISI_KATEGORI[file.kategori].label;
    meta.textContent = `${formatUkuran(file.ukuran)} • ${labelKat}`;
    info.append(nama, meta);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn-dl";
    btn.dataset.path = file.path;
    btn.setAttribute("aria-label", `Unduh ${file.nama}`);
    const ic2 = document.createElement("span");
    ic2.className = "material-icons-round";
    ic2.textContent = "download";
    btn.appendChild(ic2);

    li.append(chip, info, btn);
    fragmen.appendChild(li);
  });

  el.extractList.appendChild(fragmen);
}

/* ================== FITUR 1: KOMPRES JADI ZIP ================== */
async function kompresJadiZip() {
  if (sedangProses) return;
  if (!daftarFileTerpilih.length) {
    buatToast("Pilih minimal satu file terlebih dulu.", "gagal");
    return;
  }

  try {
    await muatJSZip();
  } catch (err) {
    buatToast(err.message, "gagal");
    return;
  }

  sedangProses = true;
  aturStatusTombol();
  mulaiProgress(el.compressProgressWrap, el.compressProgressBar, el.compressProgressText);

  try {
    const zip = new JSZip();
    const namaDipakai = new Set();

    for (const file of daftarFileTerpilih) {
      zip.file(namaUnik(file.name, namaDipakai), file);
    }

    const blob = await zip.generateAsync(
      {
        type: "blob",
        compression: "DEFLATE",
        compressionOptions: { level: 6 }
      },
      (metadata) => {
        setProgress(el.compressProgressWrap, el.compressProgressBar, el.compressProgressText, metadata.percent);
      }
    );

    await unduhBlob(blob, "Arsip_Zippy.zip");
    buatToast("Arsip_Zippy.zip berhasil dibuat & langsung terunduh!", "sukses");

    /* Bersihkan daftar setelah sukses (lepas referensi File agar GC bekerja) */
    daftarFileTerpilih = [];
    renderDaftarKompres();
  } catch (err) {
    console.error("Gagal mengompres:", err);
    buatToast(`Gagal mengompres: ${err.message}`, "gagal");
  } finally {
    sedangProses = false;
    selesaiProgress(el.compressProgressWrap, el.compressProgressBar);
    aturStatusTombol();
  }
}

/* ================== FITUR 2: EKSTRAK + KATEGORI OTOMATIS ================== */
async function ekstrakZip() {
  if (sedangProses) return;

  const file = el.inputExtract.files && el.inputExtract.files[0];
  if (!file) {
    buatToast("Pilih satu file .zip terlebih dulu.", "gagal");
    return;
  }
  if (!/\.zip$/i.test(file.name)) {
    buatToast("File yang dipilih bukan .zip", "gagal");
    return;
  }

  try {
    await muatJSZip();
  } catch (err) {
    buatToast(err.message, "gagal");
    return;
  }

  sedangProses = true;
  aturStatusTombol();
  mulaiProgressTidakTentu(el.extractProgressWrap, el.extractProgressBar, el.extractProgressText);

  try {
    lepaskanZipLama(); /* lepas arsip lama SEBELUM memuat yang baru */

    zipAktif = await JSZip.loadAsync(file);

    /* WAJIB: baca ekstensi setiap file di dalam ZIP secara otomatis */
    hasilEkstrak = [];
    zipAktif.forEach((path, entry) => {
      if (entry.dir) return;                            /* lewati folder */
      if (path.startsWith("__MACOSX/")) return;         /* sampah arsip Mac */
      if (ambilBasename(path) === ".DS_Store") return;  /* file sistem Mac */
      hasilEkstrak.push({
        path: path,
        nama: ambilBasename(path),
        kategori: klasifikasiFile(path),
        ukuran: ukuranEntry(entry)
      });
    });

    if (!hasilEkstrak.length) {
      buatToast("ZIP tidak berisi file yang bisa dibaca.", "gagal");
      el.resultSection.hidden = true;
      return;
    }

    kategoriAktif = "semua";
    el.resultSection.hidden = false;
    perbaruiBento();
    renderDaftarEkstrak();
    el.resultSection.scrollIntoView({ behavior: "smooth", block: "start" });
    buatToast(`Berhasil! ${hasilEkstrak.length} file terkategori otomatis.`, "sukses");
  } catch (err) {
    console.error("Gagal mengekstrak:", err);
    buatToast(`Gagal mengekstrak: ${err.message}`, "gagal");
  } finally {
    sedangProses = false;
    selesaiProgress(el.extractProgressWrap, el.extractProgressBar);
    el.inputExtract.value = ""; /* lepas referensi file besar secepatnya */
    el.extractLabel.textContent = "Ketuk untuk memilih file .zip";
    aturStatusTombol();
  }
}

/* ================== EVENT LISTENERS ================== */

/* Pilih file untuk dikompres (multiple) */
el.inputCompress.addEventListener("change", () => {
  const fileBaru = Array.from(el.inputCompress.files || []);
  el.inputCompress.value = ""; /* reset agar file yang sama bisa dipilih ulang */
  if (fileBaru.length) {
    daftarFileTerpilih.push(...fileBaru);
    buatToast(`${fileBaru.length} file ditambahkan ke daftar.`, "sukses");
  }
  renderDaftarKompres();
});

/* Hapus satu file dari daftar kompres (event delegation = anti memory leak) */
el.compressList.addEventListener("click", (event) => {
  const btn = event.target.closest(".btn-hapus");
  if (!btn) return;
  const index = Number(btn.dataset.index);
  if (!Number.isNaN(index) && index >= 0 && index < daftarFileTerpilih.length) {
    daftarFileTerpilih.splice(index, 1);
    renderDaftarKompres();
  }
});

/* Pilih file ZIP untuk diekstrak */
el.inputExtract.addEventListener("change", () => {
  const file = el.inputExtract.files && el.inputExtract.files[0];
  if (file) {
    el.extractLabel.textContent = file.name;
    buatToast("File ZIP siap diekstrak.", "info");
  } else {
    el.extractLabel.textContent = "Ketuk untuk memilih file .zip";
  }
  aturStatusTombol();
});

/* Tombol aksi utama */
el.btnCompress.addEventListener("click", kompresJadiZip);
el.btnExtract.addEventListener("click", ekstrakZip);

/* Tab kategori pada Bento Grid */
el.bentoTiles.forEach((tile) => {
  tile.addEventListener("click", () => {
    kategoriAktif = tile.dataset.cat;
    perbaruiBento();
    renderDaftarEkstrak();
  });
});

/* Tombol unduh per file (event delegation = anti memory leak) */
el.extractList.addEventListener("click", (event) => {
  const btn = event.target.closest(".btn-dl");
  if (!btn || sedangProses) return;
  unduhFile(btn.dataset.path);
});

/* Bersihkan hasil ekstraksi + lepas memori arsip */
el.btnBersihkan.addEventListener("click", () => {
  lepaskanZipLama();
  el.resultSection.hidden = true;
  el.extractList.textContent = "";
  buatToast("Hasil dibersihkan, memori arsip dilepas.", "info");
});

/* ------------------ INISIALISASI ------------------ */
renderDaftarKompres();
aturStatusTombol();