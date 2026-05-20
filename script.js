/* ══════════════════════════════════════════════
   AUNA — PORTAL ASESORES | script.js (Supabase Enterprise Full)
   ══════════════════════════════════════════════ */

// ─── CONFIGURACIÓN DE SUPABASE ───
const SUPABASE_URL = 'https://yemdfadeczjrvxptyerl.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InllbWRmYWRlY3pqcnZ4cHR5ZXJsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE4NzU1OTMsImV4cCI6MjA4NzQ1MTU5M30.MrWtFAhekPyuEUs0zgT3VSqYgPwd9o25lMdCuhxqwg4';

// Custom Fetch para destruir sockets congelados por el Sistema Operativo (Chrome Mobile)
const customSupabaseFetch = async (url, options) => {
    // Si es un request crítico del login (auth o rpc) usamos un timeout agresivo con reintento
    const isLoginCritical = url.includes('/auth/v1/') || url.includes('/rest/v1/rpc/');
    const timeoutMs = isLoginCritical ? 2500 : 15000; // 2.5s es suficiente para darse cuenta de un cuelgue TCP
    
    let controller = new AbortController();
    let timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    
    try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        clearTimeout(timeoutId);
        return response;
    } catch (error) {
        clearTimeout(timeoutId);
        // Si el request inicial aborta por timeout, es casi seguro un socket zombie.
        // Al lanzar un nuevo fetch inmediatamente después de abortar, el navegador 
        // crea una nueva conexión TCP limpia, resolviendo el cuelgue mágicamente.
        if (error.name === 'AbortError' && isLoginCritical) {
            console.log("Socket muerto detectado. Forzando nueva conexión TCP...");
            controller = new AbortController();
            timeoutId = setTimeout(() => controller.abort(), 8000); // El reintento tiene más tiempo por si la red es lenta
            const retryResponse = await fetch(url, { ...options, signal: controller.signal });
            clearTimeout(timeoutId);
            return retryResponse;
        }
        throw error;
    }
};

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    global: {
        fetch: customSupabaseFetch
    }
});

// ─── Variables Globales ───
let allLeads = [];
let currentPage = 1;
const PAGE_SIZE = 20;
let realtimeChannel = null;

// ─── Variables de Calidad ───
let allCalidad = [];
let calidadFiltroStatus = 'Todos';
let calidadFiltroAsesor = '';
let calidadEditandoId = null;

// ─── Variables de Paginación ───
let carteraPaginaActual = 1;
let calidadPaginaActual = 1;

// ─── Variables de Seguridad (Watchdog) ───
let temporizadorInactividad;
const TIEMPO_INACTIVIDAD_MS = 60 * 60 * 1000; // 60 Minutos

/* ══════════════════════════════════════════════
   SISTEMA DE SESIÓN Y SEGURIDAD (WATCHDOG)
══════════════════════════════════════════════ */
const SESSION_KEY = "auna_perfil"; // Ahora solo es una caché visual temporal

function guardarSesion(usuario, rol, agente, equipo) {
    try {
        const sesion = { usuario, rol, agente, equipo };
        sessionStorage.setItem(SESSION_KEY, JSON.stringify(sesion));
    } catch (e) {
        console.warn("No se pudo guardar la sesión", e);
    }
}

function leerSesion() {
    try {
        const raw = sessionStorage.getItem(SESSION_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}

function borrarSesionCache() {
    try {
        sessionStorage.removeItem(SESSION_KEY);
    } catch (e) {
        console.warn("No se pudo borrar la sesión", e);
    }
}

// 1. Escuchador Global de Estado (Motor de Supabase)
supabaseClient.auth.onAuthStateChange(async (event, session) => {
    if (event === 'SIGNED_IN' && session) {
        // Si no tenemos el perfil en caché, lo descargamos
        if (!leerSesion()) {
            const { data: usuario } = await supabaseClient
                .from('usuarios')
                .select('*')
                .eq('id', session.user.id)
                .single();

            if (usuario) {
                guardarSesion(usuario.usuario, usuario.rol, usuario.agente, usuario.equipo);
                mostrarPantallaFormulario(usuario);
            }
        } else {
            mostrarPantallaFormulario(leerSesion());
        }
        reiniciarTemporizador();
    }

    if (event === 'SIGNED_OUT' || event === 'USER_DELETED') {
        borrarSesionCache();
        document.getElementById("form-section").style.display = "none";
        document.getElementById("login-section").style.display = "block";
        if (realtimeChannel) {
            supabaseClient.removeChannel(realtimeChannel);
            realtimeChannel = null;
        }
    }
});

// 2. Watchdog de Inactividad (Sincrónico y Optimizado)
let ultimoMovimiento = 0;

function reiniciarTemporizador() {
    // FRENO: Solo registramos la actividad del mouse 1 vez por segundo para no saturar la memoria
    const ahora = Date.now();
    if (ahora - ultimoMovimiento < 1000) return;
    ultimoMovimiento = ahora;

    // VALIDACIÓN RÁPIDA: Si la pantalla de formulario está oculta, sabemos que no está logueado
    const formSection = document.getElementById("form-section");
    if (!formSection || formSection.style.display === "none") return;

    // LIMPIEZA SINCRÓNICA: Borramos el cronómetro anterior y creamos uno nuevo de forma inmediata
    clearTimeout(temporizadorInactividad);
    temporizadorInactividad = setTimeout(cerrarSesionPorInactividad, TIEMPO_INACTIVIDAD_MS);
}

async function cerrarSesionPorInactividad() {
    console.log("Sesión expirada por inactividad.");
    alert("Tu sesión ha expirado por inactividad. Vuelve a iniciar sesión para continuar.");
    await logout();
    // Capa 4: Hard reload para limpiar procesos colgados del celular
    window.location.reload();
}

// 3. Detectar si el asesor está trabajando
['mousemove', 'keypress', 'click', 'touchstart', 'scroll'].forEach(evt => {
    window.addEventListener(evt, reiniciarTemporizador);
});

// 4. Verificación inicial al abrir la página
(async function verificarSesionInicial() {
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (!session) {
        document.getElementById("login-section").style.display = "block";
        document.getElementById("form-section").style.display = "none";
    }
})();


/* ══════════════════════════════════════════════
   NOTIFICACIÓN SUTIL EN TIEMPO REAL (Proyecciones)
══════════════════════════════════════════════ */
const rtStyle = document.createElement('style');
rtStyle.innerHTML = `
  #rt-toast {
    position: fixed; bottom: 5.5rem; right: 2rem;
    background: var(--blue-700); color: white;
    padding: 12px 20px; border-radius: var(--radius-md);
    font-weight: 600; font-size: 0.9rem;
    display: none; align-items: center; gap: 10px;
    box-shadow: 0 8px 24px rgba(0,61,153,0.4);
    z-index: 999; border: 1px solid var(--blue-600);
  }
`;
document.head.appendChild(rtStyle);

const rtToast = document.createElement('div');
rtToast.id = 'rt-toast';
document.body.appendChild(rtToast);

function mostrarToastRealtime(mensaje) {
    const toast = document.getElementById("rt-toast");
    toast.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width:18px;height:18px;flex-shrink:0"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg> ${mensaje}`;
    toast.style.display = "flex";
    toast.style.animation = "slideInRight 0.3s ease";
    setTimeout(() => {
        toast.style.animation = "none";
        toast.style.display = "none";
    }, 4500);
}


/* ══════════════════════════════════════════════
   SISTEMA DE TIEMPO REAL (WEBSOCKETS FULL)
══════════════════════════════════════════════ */
function iniciarSuscripcionTiempoReal() {
    const miRol = leerSesion()?.rol;
    const miUsuario = leerSesion()?.usuario;

    if (realtimeChannel) supabaseClient.removeChannel(realtimeChannel);

    realtimeChannel = supabaseClient.channel('auna-db-changes')
        // 1. Escuchar PROYECCIÓN
        .on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'proyeccion' },
            (payload) => {
                const usuarioModificado = payload.new?.usuario || payload.old?.usuario;
                if (miRol === "Administrador" && usuarioModificado && usuarioModificado !== miUsuario) {
                    const nombreAsesor = _proy_usuariosAdmin.find(u => u.usuario === usuarioModificado)?.agente || usuarioModificado;
                    mostrarToastRealtime(`<strong>${nombreAsesor}</strong> ha actualizado su proyección`);
                    proy_recargarSilencioso();
                } else if (usuarioModificado === miUsuario && payload.new?.usuario) {
                    proy_recargarSilencioso();
                }
            }
        )
        // 2. Escuchar LEADS
        .on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'leads' },
            (payload) => {
                const usuarioModificado = payload.new?.usuario || payload.old?.usuario;
                if (miRol === "Administrador") {
                    leads_recargarSilencioso();
                } else if (usuarioModificado === miUsuario) {
                    leads_recargarSilencioso();
                }
            }
        )
        // 3. Escuchar CARTERA
        .on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'cartera' },
            (payload) => {
                const usuarioModificado = payload.new?.usuario || payload.old?.usuario;
                if (miRol === "Administrador" && usuarioModificado && usuarioModificado !== miUsuario) {
                    cartera_recargarSilencioso();
                } else if (usuarioModificado === miUsuario) {
                    cartera_recargarSilencioso();
                }
            }
        )
        // 4. Escuchar CALIDAD
        .on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'calidad' },
            (payload) => {
                const usuarioModificado = payload.new?.usuario || payload.old?.usuario;
                if (miRol === "Administrador" && usuarioModificado && usuarioModificado !== miUsuario) {
                    cal_recargarSilencioso();
                } else if (usuarioModificado === miUsuario) {
                    cal_recargarSilencioso();
                }
            }
        )
        .subscribe();
}

async function leads_recargarSilencioso() {
    const rol = leerSesion()?.rol;
    const miUser = leerSesion()?.usuario;
    try {
        let query = supabaseClient.from('leads').select('*').limit(10000);
        if (rol !== "Administrador") query = query.eq('usuario', miUser);

        const { data: leadsData, error } = await query;
        if (error) throw error;

        allLeads = leadsData || [];
        allLeads.sort((a, b) => {
            const da = parseFechaParaFiltro(a.fecha);
            const db = parseFechaParaFiltro(b.fecha);
            if (da && db) return db - da;
            if (!da) return 1;
            if (!db) return -1;
            return 0;
        });

        const vistaLista = document.getElementById("vista-lista");
        const vistaStats = document.getElementById("vista-stats");

        if (vistaLista && vistaLista.style.display !== "none") {
            document.getElementById("records-sub").textContent =
                `${allLeads.length} lead${allLeads.length !== 1 ? "s" : ""} encontrado${allLeads.length !== 1 ? "s" : ""}`;
            aplicarFiltros();
        }

        if (vistaStats && vistaStats.style.display === "block") {
            renderStats();
        }
    } catch (error) {
        console.error("Error en recarga silenciosa de leads:", error);
    }
}

async function proy_recargarSilencioso() {
    const hoy = proy_fechaHoyLima();
    const rol = leerSesion()?.rol;
    const miUsuario = leerSesion()?.usuario;

    try {
        const { data: proyecciones } = await supabaseClient.from('proyeccion').select('*').eq('dia', hoy);
        if (rol === "Administrador") {
            proy_renderAdmin(proyecciones || [], _proy_usuariosAdmin);
        } else {
            const misFilas = (proyecciones || []).filter(f => (f.usuario || "").toLowerCase() === miUsuario.toLowerCase());
            if (misFilas.length > 0 && document.getElementById("proy-preview-view").style.display === "block") {
                proy_renderPreview(misFilas);
            }
        }
    } catch (error) {
        console.error("Error en recarga silenciosa de proyección:", error);
    }
}


/* ══════════════════════════════════════════════
   SHOW / HIDE PASSWORD
══════════════════════════════════════════════ */
function togglePass() {
    const input = document.getElementById("password");
    const icon = document.getElementById("eye-icon");
    const isHidden = input.type === "password";
    input.type = isHidden ? "text" : "password";
    icon.innerHTML = isHidden
        ? `<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>`
        : `<path d="M1 12S5 4 12 4s11 8 11 8-4 8-11 8S1 12 1 12z"/><circle cx="12" cy="12" r="3"/>`;
}


/* ══════════════════════════════════════════════
   LOGIN (Supabase)
══════════════════════════════════════════════ */
let isLoggingIn = false;

async function login() {
    // Capa 1: Mutex (Candado Anti-Spam de clics)
    if (isLoggingIn) return;

    const userIn = document.getElementById("username").value.trim().toLowerCase();
    const passIn = document.getElementById("password").value;

    if (!userIn || !passIn) {
        showLoginError("Ingresa usuario y contraseña");
        return;
    }

    isLoggingIn = true;
    setLoginLoading(true);
    document.getElementById("login-error").style.display = "none";

    try {
        // Capa 2: Freno de Emergencia (Timeout de 8 segundos)
        const loginPromise = (async () => {
            // Capa 3: Exorcismo de Sesión Zombie (Limpieza profunda)
            // Se mueve DENTRO de la promesa para que el timeout de 8s aplique en caso de que signOut() se cuelgue por red suspendida
            try {
                // Lanzamos la limpieza de Supabase. Si se cuelga, el Promise.race nos salvará.
                // Usamos un timeout interno muy corto para el signOut y no bloquear el login.
                const signoutPromise = supabaseClient.auth.signOut().catch(() => { });
                const signoutTimeout = new Promise(resolve => setTimeout(resolve, 2000));
                await Promise.race([signoutPromise, signoutTimeout]);
                
                Object.keys(localStorage).forEach(key => {
                    if (key.startsWith('sb-')) localStorage.removeItem(key);
                });
            } catch (e) {
                console.warn("No se pudo limpiar la caché local (SecurityError o similar)", e);
            }

            // 1. Buscamos el email real en la base de datos
            const { data: emailLogin } = await supabaseClient.rpc('obtener_email_de_usuario', { p_username: userIn });

            // Validamos que el email exista antes de intentar el login
            if (!emailLogin) {
                return { success: false, msg: "El usuario no tiene un correo asociado o no existe." };
            }

            // 2. Intento de login solo con el email obtenido de la base de datos
            const { data: authData, error: authError } = await supabaseClient.auth.signInWithPassword({
                email: emailLogin,
                password: passIn
            });

            if (authError || !authData.user) {
                return { success: false, msg: "Usuario o contraseña incorrectos." };
            }

            // 3. Obtener datos complementarios del perfil
            const { data: usuario } = await supabaseClient
                .from('usuarios')
                .select('*')
                .eq('id', authData.user.id)
                .single();

            if (usuario) {
                guardarSesion(usuario.usuario, usuario.rol, usuario.agente, usuario.equipo);
                mostrarPantallaFormulario(usuario);
                return { success: true };
            } else {
                return { success: false, msg: "No se pudo cargar tu perfil." };
            }
        })();

        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('TIMEOUT_EMERGENCIA')), 8000)
        );

        const result = await Promise.race([loginPromise, timeoutPromise]);

        if (result && !result.success) {
            showLoginError(result.msg);
        }

    } catch (error) {
        if (error.message === 'TIMEOUT_EMERGENCIA') {
            showLoginError("La red es inestable. Abortando conexión para proteger la app...");
            // Si hubo timeout, es posible que la red del móvil esté corrupta, forzamos recarga
            setTimeout(() => window.location.reload(), 2500);
        } else {
            showLoginError("Error al conectar. Verifica tu conexión.");
        }
    } finally {
        isLoggingIn = false;
        setLoginLoading(false);
    }
}

function setLoginLoading(loading) {
    const btn = document.getElementById("login-btn");
    const text = btn.querySelector(".btn-text");
    const loader = btn.querySelector(".btn-loader");
    btn.disabled = loading;
    text.style.display = loading ? "none" : "";
    loader.style.display = loading ? "flex" : "none";
}

function showLoginError(msg) {
    const el = document.getElementById("login-error");
    el.style.display = "flex";
    if (msg) el.lastChild.textContent = " " + msg;
    el.style.animation = "none";
    el.offsetHeight;
    el.style.animation = "fadeUp 0.3s ease";
}

document.addEventListener("DOMContentLoaded", () => {
    // --- Mobile Splash Screen Animation ---
    if (window.innerWidth <= 640) {
        const loginSplit = document.querySelector('.login-split');
        if (loginSplit) {
            setTimeout(() => {
                loginSplit.classList.add('splash-active');
            }, 500);
        }
    }
    // ---------------------------------------

    document.getElementById("password")?.addEventListener("keydown", (e) => {
        if (e.key === "Enter") login();
    });
    document.getElementById("username")?.addEventListener("keydown", (e) => {
        if (e.key === "Enter") document.getElementById("password").focus();
    });

    ["telefono", "edit-telefono", "edad", "edit-edad"].forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        const isTel = id.includes("telefono");
        el.setAttribute("maxlength", isTel ? "9" : "3");
        el.setAttribute("inputmode", "numeric");
        el.addEventListener("input", () => { el.value = el.value.replace(/\D/g, "").slice(0, isTel ? 9 : 3); });
        el.addEventListener("keydown", (e) => {
            const allowed = ["Backspace", "Delete", "ArrowLeft", "ArrowRight", "Tab", "Home", "End"];
            if (!allowed.includes(e.key) && !/^\d$/.test(e.key)) e.preventDefault();
        });
    });
});
function formatDecimalInput(input) {
    let val = input.value.replace(/,/g, '.'); // Replace comma with dot
    val = val.replace(/[^0-9.]/g, ''); // Remove non-numeric/dot characters

    // Ensure only one dot
    const parts = val.split('.');
    if (parts.length > 2) {
        val = parts[0] + '.' + parts.slice(1).join('');
    }

    // Max 2 decimals
    if (val.includes('.')) {
        const dec = val.split('.')[1];
        if (dec.length > 2) {
            val = val.substring(0, val.indexOf('.') + 3);
        }
    }

    input.value = val;
}


/* ══════════════════════════════════════════════
   MOSTRAR PANTALLA FORMULARIO
══════════════════════════════════════════════ */
function mostrarPantallaFormulario(user) {
    document.getElementById("login-section").style.display = "none";
    document.getElementById("form-section").style.display = "block";

    const nombre = user.agente || user.usuario;
    const equipo = user.equipo || "Mi Equipo";

    // Topbar: Solo el nombre del equipo, centrado
    document.getElementById("topbar-title").textContent = equipo;

    document.getElementById("user-name-chip").textContent = nombre;
    document.getElementById("user-avatar").textContent = nombre.charAt(0).toUpperCase();

    // Formulario: Saludo más humano y pequeño
    document.getElementById("form-title").textContent = `Hola, ${nombre}👋🏼. Registra tu Lead`;

    iniciarSuscripcionTiempoReal();
}


/* ══════════════════════════════════════════════
   LOGOUT (UI Cleans and Supabase Auth out)
══════════════════════════════════════════════ */
async function logout() {
    // 1. Limpiamos las variables de entorno visual
    allLeads = [];
    currentPage = 1;
    activeQuickFilter = "todos";
    currentStatsPeriod = "mes";
    calMesAsesor = null;
    exportPeriod = "todos";
    if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
    if (qrInstance) { qrInstance = null; }
    cot_initialised = false;
    cot_modoPanel = "asesor";
    cot_currentInt = 1;
    cot_modoActuarial = false;
    proy_filasCount = 0;

    // Cartera resets
    allCartera = [];
    carteraFiltroEstado = 'todos';
    carteraFiltroPlan = 'todos';
    carteraFiltroAsesor = 'todos';
    carteraEditandoId = null;

    // Calidad resets
    allCalidad = [];
    calidadFiltroStatus = 'Todos';
    calidadFiltroAsesor = '';
    calidadEditandoId = null;

    // Pagination resets
    carteraPaginaActual = 1;
    calidadPaginaActual = 1;

    const tablaEl = document.getElementById("tabla-registros");
    if (tablaEl) tablaEl.innerHTML = `
    <div class="empty-state">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>
      <p>Haz clic en <strong>Actualizar</strong> para cargar tus registros.</p>
    </div>`;

    const wrapAsesor = document.getElementById("wrap-filtro-asesor");
    const btnStats = document.getElementById("btn-ir-stats");
    const wrapStats = document.getElementById("wrap-stats-asesor");
    if (wrapAsesor) wrapAsesor.style.display = "none";
    if (btnStats) btnStats.style.display = "none";
    if (wrapStats) wrapStats.style.display = "none";

    const vistaLista = document.getElementById("vista-lista");
    const vistaStats = document.getElementById("vista-stats");
    if (vistaLista) vistaLista.style.display = "block";
    if (vistaStats) vistaStats.style.display = "none";

    document.querySelectorAll(".qf-btn").forEach((b, i) => b.classList.toggle("active", i === 0));
    const rangoWrap = document.getElementById("rango-wrap");
    if (rangoWrap) rangoWrap.style.display = "none";
    if (document.getElementById("search-input")) document.getElementById("search-input").value = "";

    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    document.getElementById("tab-form")?.classList.add("active");
    document.getElementById("panel-form")?.classList.add("active");

    document.getElementById("barrido-form").reset();

    // 2. Destruimos el token en servidor (Esto disparará el evento onAuthStateChange)
    await supabaseClient.auth.signOut();
}


/* ══════════════════════════════════════════════
   TABS & MOBILE NAV
══════════════════════════════════════════════ */
function switchTab(tab) {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));

    document.getElementById(`tab-${tab}`).classList.add("active");
    document.getElementById(`panel-${tab}`).classList.add("active");

    if (tab === "records") verRegistros();
    if (tab === "encuesta") iniciarEncuesta();
    if (tab === "cotizador") { cot_init(); requestAnimationFrame(() => requestAnimationFrame(cot_ajustarEscala)); }
    if (tab === "proyeccion") proy_init();
    if (tab === "cartera") cartera_init();
    if (tab === "calidad") cal_init();

    const labels = {
        form: { label: "Nuevo Lead", svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>` },
        records: { label: "Mis Registros", svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 17H5a2 2 0 0 0-2 2v2h18v-2a2 2 0 0 0-2-2h-4"/><path d="M12 3v10m-4-4 4 4 4-4"/></svg>` },
        encuesta: { label: "Encuesta", svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>` },
        cotizador: { label: "Cotizador", svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>` },
        proyeccion: { label: "Proyección", svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>` },
        cartera: { label: "Cartera", svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>` },
        calidad: { label: "Calidad", svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>` }
    };
    const info = labels[tab];
    if (info) {
        document.getElementById("mobile-nav-label").textContent = info.label;
        document.getElementById("mobile-nav-icon").innerHTML = info.svg;
    }
    document.querySelectorAll(".mobile-nav-item").forEach(b => b.classList.remove("active"));
    document.getElementById(`mnav-${tab}`)?.classList.add("active");
}

function toggleMobileNav() {
    const menu = document.getElementById("mobile-nav-menu");
    const chevron = document.getElementById("mobile-nav-chevron");
    const open = menu.style.display !== "none" && menu.style.display !== "";
    menu.style.display = open ? "none" : "block";
    chevron.style.transform = open ? "" : "rotate(180deg)";
}

function closeMobileNav() {
    document.getElementById("mobile-nav-menu").style.display = "none";
    document.getElementById("mobile-nav-chevron").style.transform = "";
}

document.addEventListener("click", e => {
    const nav = document.getElementById("mobile-nav");
    if (nav && !nav.contains(e.target)) closeMobileNav();
});


/* ══════════════════════════════════════════════
   VALIDACIÓN DE LEAD
══════════════════════════════════════════════ */
function validateForm() {
    let valid = true;
    const fields = [
        { id: "nombre", errId: "err-nombre", msg: "Ingresa el nombre completo", check: (v) => v.trim().length >= 3 },
        { id: "telefono", errId: "err-telefono", msg: "El teléfono debe tener exactamente 9 dígitos", check: (v) => /^\d{9}$/.test(v.replace(/\s/g, "")) },
        { id: "edad", errId: "err-edad", msg: "Ingresa una edad válida (1–120)", check: (v) => /^\d+$/.test(v) && +v >= 1 && +v <= 120 },
        { id: "producto", errId: "err-producto", msg: "Selecciona un producto", check: (v) => v !== "" },
        { id: "temperatura", errId: "err-temperatura", msg: "Selecciona la temperatura del lead", check: (v) => v !== "" },
    ];

    fields.forEach(({ id, errId, msg, check }) => {
        const el = document.getElementById(id);
        const err = document.getElementById(errId);
        if (!check(el.value)) {
            el.classList.add("invalid");
            err.textContent = msg;
            valid = false;
        } else {
            el.classList.remove("invalid");
            err.textContent = "";
        }
    });
    return valid;
}

["nombre", "telefono", "edad", "producto", "temperatura"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) {
        el.addEventListener("input", () => { el.classList.remove("invalid"); document.getElementById(`err-${id}`)?.textContent && (document.getElementById(`err-${id}`).textContent = ""); });
        el.addEventListener("change", () => { el.classList.remove("invalid"); });
    }
});


/* ══════════════════════════════════════════════
   GUARDAR LEAD (Supabase)
══════════════════════════════════════════════ */
document.getElementById("barrido-form").addEventListener("submit", async function (e) {
    e.preventDefault();
    if (!validateForm()) return;

    setSubmitLoading(true);

    const datos = {
        usuario: String(leerSesion()?.usuario),
        fecha: (() => {
            const now = new Date();
            const parts = new Intl.DateTimeFormat("en-US", {
                timeZone: "America/Lima",
                day: "2-digit", month: "2-digit", year: "numeric",
                hour: "numeric", minute: "2-digit", hour12: true,
            }).formatToParts(now);
            const get = (t) => parts.find(p => p.type === t)?.value ?? "";
            const ampm = get("dayPeriod").toLowerCase();
            return `${get("day")}/${get("month")}/${get("year")} ${get("hour")}:${get("minute")} ${ampm}`;
        })(),
        nombre: String(document.getElementById("nombre").value.trim()),
        telefono: String(document.getElementById("telefono").value.replace(/\s/g, "")),
        edad: String(document.getElementById("edad").value),
        producto: String(document.getElementById("producto").value),
        temperatura: String(document.getElementById("temperatura").value),
        referencia: String(document.getElementById("referencia").value.trim()),
        comentarios: String(document.getElementById("comentarios").value.trim()),
    };

    try {
        const { error } = await supabaseClient.from('leads').insert([datos]);
        if (error) throw error;

        window._ultimoLead = {
            nombre: datos.nombre,
            telefono: datos.telefono,
            producto: datos.producto,
        };

        this.reset();
        showToast();

        ["nombre", "telefono", "edad", "producto", "temperatura"].forEach((id) => {
            document.getElementById(id)?.classList.remove("invalid");
        });

        abrirWaModal(window._ultimoLead);

    } catch (error) {
        console.error("Detalle DB (Insertar Lead):", error);
        alert("Error al guardar el registro. Verifica tu conexión e intenta de nuevo.");
    } finally {
        setSubmitLoading(false);
    }
});

function setSubmitLoading(loading) {
    const btn = document.getElementById("submit-btn");
    const text = btn.querySelector(".btn-text");
    const ldr = btn.querySelector(".btn-loader");
    btn.disabled = loading;
    text.style.display = loading ? "none" : "flex";
    ldr.style.display = loading ? "flex" : "none";
}

function showToast() {
    const toast = document.getElementById("toast");
    toast.style.display = "flex";
    setTimeout(() => {
        toast.style.animation = "none";
        toast.style.display = "none";
        toast.style.animation = "";
    }, 3500);
}


/* ══════════════════════════════════════════════
   VER REGISTROS (Supabase)
══════════════════════════════════════════════ */
async function verRegistros() {
    const contenedor = document.getElementById("tabla-registros");
    const btn = document.querySelector(".btn-refresh");

    btn.classList.add("spinning");
    contenedor.innerHTML = `
    <div class="loading-state">
      <div class="loading-dots"><span></span><span></span><span></span></div>
      <p>Cargando registros...</p>
    </div>`;

    const rol = leerSesion()?.rol;
    const miUser = leerSesion()?.usuario;

    try {
        let query = supabaseClient.from('leads').select('*').limit(10000);

        if (rol !== "Administrador") {
            query = query.eq('usuario', miUser);
        }

        const { data: leadsData, error } = await query;
        if (error) throw error;

        allLeads = leadsData || [];

        allLeads.sort((a, b) => {
            const da = parseFechaParaFiltro(a.fecha);
            const db = parseFechaParaFiltro(b.fecha);
            if (da && db) return db - da;
            if (!da) return 1;
            if (!db) return -1;
            return 0;
        });

        currentPage = 1;
        document.getElementById("btn-ir-stats").style.display = "flex";

        if (rol === "Administrador") {
            document.getElementById("wrap-filtro-asesor").style.display = "flex";
            document.getElementById("wrap-stats-asesor").style.display = "flex";
            poblarSelectAsesores();
        }

        document.getElementById("records-sub").textContent =
            `${allLeads.length} lead${allLeads.length !== 1 ? "s" : ""} encontrado${allLeads.length !== 1 ? "s" : ""}`;

        renderTable(allLeads, contenedor);

    } catch (e) {
        console.error("Detalle DB (Leer Leads):", e);
        contenedor.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        <p>No se pudieron cargar los registros.<br>Verifica tu conexión.</p>
      </div>`;
    } finally {
        btn.classList.remove("spinning");
    }
}


/* ══════════════════════════════════════════════
   FILTROS RÁPIDOS Y BÚSQUEDA
══════════════════════════════════════════════ */
let activeQuickFilter = "todos";

function setQuickFilter(tipo) {
    activeQuickFilter = tipo;
    ["todos", "hoy", "semana", "mes", "rango"].forEach(t => {
        const btn = document.getElementById("qf-" + t);
        if (btn) btn.classList.toggle("active", t === tipo);
    });
    const rangoWrap = document.getElementById("rango-wrap");
    if (rangoWrap) rangoWrap.style.display = tipo === "rango" ? "block" : "none";
    if (tipo !== "rango") {
        const d = document.getElementById("fecha-desde");
        const h = document.getElementById("fecha-hasta");
        if (d) d.value = "";
        if (h) h.value = "";
    }
    aplicarFiltros();
}

function toggleRangoPersonalizado() {
    const esRango = activeQuickFilter === "rango";
    setQuickFilter(esRango ? "todos" : "rango");
}

function aplicarFiltros(preservePage = false) {
    const q = document.getElementById("search-input")?.value.toLowerCase() || "";
    const desde = document.getElementById("fecha-desde")?.value || "";
    const hasta = document.getElementById("fecha-hasta")?.value || "";
    const asesorSel = document.getElementById("filtro-asesor")?.value || "todos";

    const filtrados = allLeads.filter((l) => {
        const asesorOk = asesorSel === "todos" || (l.usuario || "").toLowerCase() === asesorSel.toLowerCase();

        const textoOk = !q ||
            (l.nombre || "").toLowerCase().includes(q) ||
            (l.producto || "").toLowerCase().includes(q) ||
            (l.telefono || "").toString().includes(q) ||
            (l.usuario || "").toLowerCase().includes(q);

        let fechaOk = true;
        const fechaLead = parseFechaParaFiltro(l.fecha);

        if (activeQuickFilter === "hoy") {
            const b = getLimaBounds("hoy");
            fechaOk = fechaLead ? fechaLead >= b.ini && fechaLead <= b.fin : false;
        } else if (activeQuickFilter === "semana") {
            const b = getLimaBounds("semana");
            fechaOk = fechaLead ? fechaLead >= b.ini && fechaLead <= b.fin : false;
        } else if (activeQuickFilter === "mes") {
            const b = getLimaBounds("mes");
            fechaOk = fechaLead ? fechaLead >= b.ini && fechaLead <= b.fin : false;
        } else if (activeQuickFilter === "rango" && (desde || hasta)) {
            if (desde && fechaLead) {
                const [y, m, d] = desde.split("-").map(Number);
                fechaOk = fechaOk && fechaLead >= new Date(Date.UTC(y, m - 1, d, 5, 0, 0, 0));
            }
            if (hasta && fechaLead) {
                const [y, m, d] = hasta.split("-").map(Number);
                fechaOk = fechaOk && fechaLead <= new Date(Date.UTC(y, m - 1, d, 28, 59, 59, 999));
            }
            if (!fechaLead && (desde || hasta)) fechaOk = false;
        }

        return asesorOk && textoOk && fechaOk;
    });

    if (!preservePage) currentPage = 1;
    renderTable(filtrados, document.getElementById("tabla-registros"));
}

function parseFechaParaFiltro(valor) {
    if (!valor) return null;
    const mDDMMYYYY = String(valor).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*(am|pm)$/i);
    if (mDDMMYYYY) {
        const day = parseInt(mDDMMYYYY[1], 10);
        const mon = parseInt(mDDMMYYYY[2], 10) - 1;
        const yr = parseInt(mDDMMYYYY[3], 10);
        let h = parseInt(mDDMMYYYY[4], 10);
        const min = parseInt(mDDMMYYYY[5], 10);
        const ampm = mDDMMYYYY[6].toLowerCase();
        if (ampm === "pm" && h !== 12) h += 12;
        if (ampm === "am" && h === 12) h = 0;
        return new Date(Date.UTC(yr, mon, day, h + 5, min, 0, 0));
    }
    const iso = new Date(valor);
    if (!isNaN(iso.getTime())) return iso;
    return null;
}

function getLimaBounds(tipo) {
    const nowLima = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Lima" }));
    const yr = nowLima.getFullYear();
    const mon = nowLima.getMonth();
    const day = nowLima.getDate();
    const dow = nowLima.getDay();

    if (tipo === "hoy") {
        const ini = new Date(Date.UTC(yr, mon, day, 5, 0, 0, 0));
        const fin = new Date(Date.UTC(yr, mon, day, 28, 59, 59, 999));
        return { ini, fin };
    }
    if (tipo === "semana") {
        const diffLunes = (dow + 6) % 7;
        const lunes = new Date(Date.UTC(yr, mon, day - diffLunes, 5, 0, 0, 0));
        const domingo = new Date(Date.UTC(yr, mon, day - diffLunes + 6, 28, 59, 59, 999));
        return { ini: lunes, fin: domingo };
    }
    if (tipo === "mes") {
        const ini = new Date(Date.UTC(yr, mon, 1, 5, 0, 0, 0));
        const fin = new Date(Date.UTC(yr, mon + 1, 0, 28, 59, 59, 999));
        return { ini, fin };
    }
    return null;
}

function limpiarFechas() {
    document.getElementById("fecha-desde").value = "";
    document.getElementById("fecha-hasta").value = "";
    aplicarFiltros();
}


/* ══════════════════════════════════════════════
   MODAL DE EXPORTACIÓN EXCEL
══════════════════════════════════════════════ */
let exportPeriod = "todos";

function exportarExcel() {
    const overlay = document.getElementById("export-modal-overlay");
    overlay.style.display = "flex";
    overlay.offsetHeight;
    overlay.classList.add("active");
    document.body.style.overflow = "hidden";

    exportPeriod = activeQuickFilter;
    document.querySelectorAll(".export-period-btn").forEach(b => b.classList.remove("active"));
    const syncBtn = document.getElementById("ep-" + exportPeriod);
    if (syncBtn) syncBtn.classList.add("active");

    const usuario = leerSesion()?.agente || leerSesion()?.usuario || "Leads";
    document.getElementById("export-filename").value = `Leads_${usuario}`;
    actualizarPreview();

    document.getElementById("export-rango-wrap").style.display = exportPeriod === "rango" ? "flex" : "none";

    document.getElementById("export-filename").oninput = () => {
        const val = document.getElementById("export-filename").value.trim() || "Mis_Leads";
        document.getElementById("filename-preview").textContent = val + ".xlsx";
    };
    document.getElementById("filename-preview").textContent =
        (document.getElementById("export-filename").value.trim() || "Mis_Leads") + ".xlsx";
}

function closeExportModal(event) {
    if (event && event.target !== document.getElementById("export-modal-overlay")) return;
    const overlay = document.getElementById("export-modal-overlay");
    overlay.classList.remove("active");
    setTimeout(() => { overlay.style.display = "none"; document.body.style.overflow = ""; }, 250);
}

function selectExportPeriod(period, btn) {
    exportPeriod = period;
    document.querySelectorAll(".export-period-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("export-rango-wrap").style.display = period === "rango" ? "flex" : "none";
    actualizarPreview();
}

function getLeadsFiltradosParaExportar() {
    const desde = document.getElementById("exp-desde")?.value || "";
    const hasta = document.getElementById("exp-hasta")?.value || "";

    return allLeads.filter((l) => {
        const fechaLead = parseFechaParaFiltro(l.fecha);
        if (exportPeriod === "hoy") {
            const b = getLimaBounds("hoy");
            return fechaLead ? fechaLead >= b.ini && fechaLead <= b.fin : false;
        }
        if (exportPeriod === "semana") {
            const b = getLimaBounds("semana");
            return fechaLead ? fechaLead >= b.ini && fechaLead <= b.fin : false;
        }
        if (exportPeriod === "mes") {
            const b = getLimaBounds("mes");
            return fechaLead ? fechaLead >= b.ini && fechaLead <= b.fin : false;
        }
        if (exportPeriod === "rango") {
            let ok = true;
            if (desde && fechaLead) {
                const [y, m, d] = desde.split("-").map(Number);
                ok = ok && fechaLead >= new Date(Date.UTC(y, m - 1, d, 5, 0, 0, 0));
            }
            if (hasta && fechaLead) {
                const [y, m, d] = hasta.split("-").map(Number);
                ok = ok && fechaLead <= new Date(Date.UTC(y, m - 1, d, 28, 59, 59, 999));
            }
            if (!fechaLead && (desde || hasta)) ok = false;
            return ok;
        }
        return true;
    });
}

function actualizarPreview() {
    const datos = getLeadsFiltradosParaExportar();
    const labels = { todos: "Todos los registros", hoy: "Hoy", semana: "Esta semana", mes: "Este mes", rango: "Rango personalizado" };
    document.getElementById("preview-count").textContent = datos.length;
    document.getElementById("preview-period").textContent = labels[exportPeriod] || "—";
}

function ejecutarExportacion() {
    const datos = getLeadsFiltradosParaExportar();
    if (datos.length === 0) {
        alert("No hay leads en el período seleccionado para exportar.");
        return;
    }

    const rol = leerSesion()?.rol;
    const mostrarAsesor = rol === "Administrador";
    const usuario = leerSesion()?.agente || leerSesion()?.usuario || "";
    const filename = (document.getElementById("export-filename").value.trim() || "Mis_Leads") + ".xlsx";

    const headers = ["Fecha", "Nombre", "Teléfono", "Edad", "Producto", "Temperatura", ...(mostrarAsesor ? ["Asesor"] : []), "Referencia", "Comentarios"];

    const filas = datos.map(d => {
        const row = {
            "Fecha": formatFecha(d.fecha),
            "Nombre": d.nombre || "",
            "Teléfono": String(d.telefono || ""),
            "Edad": d.edad || "",
            "Producto": d.producto || "",
            "Temperatura": d.temperatura || "",
            "Referencia": d.referencia || "",
            "Comentarios": d.comentarios || "",
        };
        if (mostrarAsesor) row["Asesor"] = d.usuario || "";
        const ordered = {};
        headers.forEach(h => { ordered[h] = row[h] ?? ""; });
        return ordered;
    });

    const ws = XLSX.utils.json_to_sheet(filas, { header: headers });
    ws["!cols"] = [
        { wch: 22 }, { wch: 28 }, { wch: 14 }, { wch: 8 }, { wch: 18 }, { wch: 12 },
        ...(mostrarAsesor ? [{ wch: 16 }] : []), { wch: 28 }, { wch: 36 },
    ];

    const wb = XLSX.utils.book_new();
    const sheetName = `Leads ${usuario}`.slice(0, 31);
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
    XLSX.writeFile(wb, filename);

    setTimeout(() => closeExportModal(), 300);
    showToastExport(datos.length);
}

function showToastExport(count) {
    const toast = document.getElementById("toast-edit");
    toast.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> ${count} lead${count !== 1 ? "s" : ""} exportado${count !== 1 ? "s" : ""} correctamente`;
    toast.style.display = "flex";
    setTimeout(() => {
        toast.style.display = "none";
        toast.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg> ¡Lead actualizado con éxito!`;
    }, 3500);
}


/* ══════════════════════════════════════════════
   RENDER TABLE & MODAL EDITAR (Supabase)
══════════════════════════════════════════════ */
function formatFecha(valor) {
    if (!valor) return "—";
    if (/^\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}\s*(am|pm)$/i.test(String(valor).trim())) {
        return String(valor).trim();
    }
    const date = new Date(valor);
    if (isNaN(date.getTime())) return String(valor);
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Lima",
        day: "2-digit", month: "2-digit", year: "numeric",
        hour: "numeric", minute: "2-digit", hour12: true,
    }).formatToParts(date);
    const get = (t) => parts.find(p => p.type === t)?.value ?? "";
    const ampm = get("dayPeriod").toLowerCase();
    return `${get("day")}/${get("month")}/${get("year")} ${get("hour")}:${get("minute")} ${ampm}`;
}

function getBadgeClass(producto) {
    const map = {
        "Auna Classic": "badge-classic",
        "Auna Premium": "badge-premium",
        "Auna Senior": "badge-senior",
        "Onco Pro": "badge-oncopro",
        "Onco Plus": "badge-oncoplus",
    };
    return map[producto] || "badge-classic";
}

function getTempBadge(temp) {
    if (!temp) return `<span style="color:var(--slate-300)">—</span>`;
    const cfg = {
        "Frío": { bg: "#fee2e2", color: "#b91c1c", dot: "#ef4444" },
        "Tibio": { bg: "#fef9c3", color: "#92400e", dot: "#f59e0b" },
        "Caliente": { bg: "#dcfce7", color: "#166534", dot: "#22c55e" },
    };
    const c = cfg[temp];
    if (!c) return temp;
    return `<span class="badge-temp" style="background:${c.bg};color:${c.color}">
    <span style="width:7px;height:7px;border-radius:50%;background:${c.dot};display:inline-block;margin-right:4px;flex-shrink:0"></span>${temp}
  </span>`;
}

function renderTable(datos, contenedor) {
    if (datos.length === 0) {
        contenedor.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>
        <p>No hay registros que mostrar.</p>
      </div>`;
        return;
    }

    const rol = leerSesion()?.rol;
    const mostrarAsesor = rol === "Administrador";
    const totalPages = Math.ceil(datos.length / PAGE_SIZE);

    if (currentPage < 1) currentPage = 1;
    if (currentPage > totalPages) currentPage = totalPages;

    const start = (currentPage - 1) * PAGE_SIZE;
    const end = Math.min(start + PAGE_SIZE, datos.length);
    const pagSlice = datos.slice(start, end);

    let html = `
    <div style="overflow-x:auto">
    <table class="data-table">
      <thead>
        <tr>
          <th>Fecha</th>
          <th>Nombre</th>
          <th>Teléfono</th>
          <th>Edad</th>
          <th>Producto</th>
          <th>Temp.</th>
          ${mostrarAsesor ? "<th>Asesor</th>" : ""}
          <th>Referencia</th>
          <th>Comentarios</th>
          <th style="width:40px"></th>
        </tr>
      </thead>
      <tbody>`;

    pagSlice.forEach((d) => {
        const badgeClass = getBadgeClass(d.producto);
        const globalIdx = allLeads.findIndex(l => l.id === d.id);
        const tempBadge = getTempBadge(d.temperatura);
        html += `
      <tr class="row-clickable" onclick="abrirEditModal(${globalIdx})" title="Clic para editar este lead">
        <td style="white-space:nowrap; color:var(--slate-500); font-size:0.8rem">${formatFecha(d.fecha)}</td>
        <td style="font-weight:600">${d.nombre || "—"}</td>
        <td>${String(d.telefono || "").trim() || "—"}</td>
        <td style="text-align:center">${d.edad || "—"}</td>
        <td><span class="badge-product ${badgeClass}">${d.producto || "—"}</span></td>
        <td>${tempBadge}</td>
        ${mostrarAsesor ? `<td style="color:var(--slate-500); font-size:0.82rem">${d.usuario || "—"}</td>` : ""}
        <td style="color:var(--slate-500); font-size:0.82rem; max-width:140px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap" title="${d.referencia || ""}">${d.referencia || "—"}</td>
        <td style="color:var(--slate-500); font-size:0.82rem; max-width:160px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap" title="${d.comentarios || ""}">${d.comentarios || "—"}</td>
        <td class="td-edit-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></td>
      </tr>`;
    });

    html += `</tbody></table></div><div class="table-footer">`;

    if (totalPages > 1) {
        html += `<div class="pagination">
      <button class="pag-btn" onclick="cambiarPagina(${currentPage - 1})" ${currentPage === 1 ? "disabled" : ""}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg>
      </button>`;

        const range = paginationRange(currentPage, totalPages);
        range.forEach((item) => {
            if (item === "…") {
                html += `<span class="pag-ellipsis">…</span>`;
            } else {
                html += `<button class="pag-btn pag-num ${item === currentPage ? "active" : ""}" onclick="cambiarPagina(${item})">${item}</button>`;
            }
        });

        html += `<button class="pag-btn" onclick="cambiarPagina(${currentPage + 1})" ${currentPage === totalPages ? "disabled" : ""}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
      </button></div>`;
    }
    html += `<span class="footer-count">Mostrando ${start + 1}–${end} de ${datos.length} registro${datos.length !== 1 ? "s" : ""}</span></div>`;
    contenedor.innerHTML = html;
}

function paginationRange(current, total) {
    if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
    const pages = [];
    if (current <= 4) {
        pages.push(1, 2, 3, 4, 5, "…", total);
    } else if (current >= total - 3) {
        pages.push(1, "…", total - 4, total - 3, total - 2, total - 1, total);
    } else {
        pages.push(1, "…", current - 1, current, current + 1, "…", total);
    }
    return pages;
}

function cambiarPagina(page) {
    currentPage = page;
    aplicarFiltros(true);
    document.getElementById("tabla-registros").scrollIntoView({ behavior: "smooth", block: "start" });
}

/* Modal Editar */
function abrirEditModal(idx) {
    const lead = allLeads[idx];
    if (!lead) return;

    document.getElementById("edit-row-index").value = lead.id;
    document.getElementById("edit-nombre").value = String(lead.nombre || "");
    document.getElementById("edit-telefono").value = String(lead.telefono || "");
    document.getElementById("edit-edad").value = String(lead.edad || "");
    document.getElementById("edit-producto").value = String(lead.producto || "");
    document.getElementById("edit-temperatura").value = String(lead.temperatura || "");
    document.getElementById("edit-referencia").value = String(lead.referencia || "");
    document.getElementById("edit-comentarios").value = String(lead.comentarios || "");
    document.getElementById("modal-fecha-display").textContent = `📅 Registrado el ${formatFecha(lead.fecha)}`;

    ["nombre", "telefono", "edad", "producto"].forEach(f => {
        document.getElementById(`edit-err-${f}`).textContent = "";
        document.getElementById(`edit-${f}`).classList.remove("invalid");
    });

    const overlay = document.getElementById("edit-modal-overlay");
    overlay.style.display = "flex";
    overlay.offsetHeight;
    overlay.classList.add("active");
    document.body.style.overflow = "hidden";
}

function closeEditModal(event) {
    if (event && event.target !== document.getElementById("edit-modal-overlay")) return;
    const overlay = document.getElementById("edit-modal-overlay");
    overlay.classList.remove("active");
    setTimeout(() => { overlay.style.display = "none"; document.body.style.overflow = ""; }, 250);
}

document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeEditModal();
});

function validateEditForm() {
    let valid = true;
    const fields = [
        { id: "edit-nombre", errId: "edit-err-nombre", msg: "Ingresa el nombre completo", check: (v) => v.trim().length >= 3 },
        { id: "edit-telefono", errId: "edit-err-telefono", msg: "El teléfono debe tener exactamente 9 dígitos", check: (v) => /^\d{9}$/.test(v.replace(/\s/g, "")) },
        { id: "edit-edad", errId: "edit-err-edad", msg: "Ingresa una edad válida (1–120)", check: (v) => /^\d+$/.test(v) && +v >= 1 && +v <= 120 },
        { id: "edit-producto", errId: "edit-err-producto", msg: "Selecciona un producto", check: (v) => v !== "" },
        { id: "edit-temperatura", errId: "edit-err-temperatura", msg: "Selecciona la temperatura del lead", check: (v) => v !== "" },
    ];
    fields.forEach(({ id, errId, msg, check }) => {
        const el = document.getElementById(id);
        const err = document.getElementById(errId);
        if (!check(el.value)) { el.classList.add("invalid"); err.textContent = msg; valid = false; }
        else { el.classList.remove("invalid"); err.textContent = ""; }
    });
    return valid;
}

async function guardarEdicion() {
    if (!validateEditForm()) return;

    const leadId = document.getElementById("edit-row-index").value;
    const leadIdx = allLeads.findIndex(l => l.id === leadId);
    if (leadIdx === -1) return;

    const btn = document.getElementById("btn-save-edit");
    const text = btn.querySelector(".btn-text");
    const loader = btn.querySelector(".btn-loader");
    btn.disabled = true;
    text.style.display = "none";
    loader.style.display = "flex";

    const datosEditados = {
        nombre: String(document.getElementById("edit-nombre").value.trim()),
        telefono: String(document.getElementById("edit-telefono").value.replace(/\s/g, "")),
        edad: String(document.getElementById("edit-edad").value),
        producto: String(document.getElementById("edit-producto").value),
        temperatura: String(document.getElementById("edit-temperatura").value),
        referencia: String(document.getElementById("edit-referencia").value.trim()),
        comentarios: String(document.getElementById("edit-comentarios").value.trim()),
    };

    try {
        const { error } = await supabaseClient.from('leads').update(datosEditados).eq('id', leadId);
        if (error) throw error;

        allLeads[leadIdx] = { ...allLeads[leadIdx], ...datosEditados };
        closeEditModal();
        aplicarFiltros(true);
        showToastEdit();

    } catch (error) {
        console.error("Detalle DB (Edición):", error);
        alert("Error al guardar. Verifica tu conexión e intenta de nuevo.");
    } finally {
        btn.disabled = false;
        text.style.display = "flex";
        loader.style.display = "none";
    }
}

function showToastEdit() {
    const toast = document.getElementById("toast-edit");
    toast.style.display = "flex";
    setTimeout(() => {
        toast.style.animation = "none";
        toast.style.display = "none";
        toast.style.animation = "";
    }, 3500);
}


/* ══════════════════════════════════════════════
   ENCUESTA — QR Y LINK PERSONALIZADO
══════════════════════════════════════════════ */
let qrInstance = null;

function iniciarEncuesta() {
    const usuario = leerSesion()?.usuario || "asesor";
    const baseUrl = window.location.href.replace(/\/[^/]*$/, "") + "/encuesta.html";
    const encuestaUrl = `${baseUrl}?u=${encodeURIComponent(usuario)}`;

    document.getElementById("encuesta-link-text").textContent = encuestaUrl;
    const container = document.getElementById("qr-container");

    if (container.dataset.generatedFor === usuario) return;
    container.dataset.generatedFor = usuario;
    container.innerHTML = "";

    const LOGO_URL = "https://res.cloudinary.com/dwxiuavqd/image/upload/v1774998253/468951353_1098106335437147_8489372296479282912_n_insezr.jpg";
    const QR_SIZE = 240;

    qrInstance = new QRCode(container, {
        text: encuestaUrl,
        width: QR_SIZE,
        height: QR_SIZE,
        colorDark: "#002d72",
        colorLight: "#ffffff",
        correctLevel: QRCode.CorrectLevel.H,
    });

    setTimeout(() => {
        const canvas = container.querySelector("canvas");
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        const logo = new Image();
        logo.crossOrigin = "anonymous";
        logo.onload = () => {
            const logoSize = QR_SIZE * 0.22;
            const logoX = (QR_SIZE - logoSize) / 2;
            const logoY = (QR_SIZE - logoSize) / 2;
            const padding = 6;
            const radius = 8;
            ctx.fillStyle = "#ffffff";
            ctx.beginPath();
            ctx.roundRect(logoX - padding, logoY - padding, logoSize + padding * 2, logoSize + padding * 2, radius);
            ctx.fill();
            ctx.drawImage(logo, logoX, logoY, logoSize, logoSize);
        };
        logo.src = LOGO_URL;
    }, 200);
}

function copiarLink() {
    const link = document.getElementById("encuesta-link-text").textContent;
    navigator.clipboard.writeText(link).then(() => {
        const btn = document.getElementById("btn-copy");
        const icon = document.getElementById("copy-icon");
        icon.innerHTML = `<polyline points="20 6 9 17 4 12"/>`;
        btn.style.background = "var(--green-500)";
        btn.style.color = "white";
        setTimeout(() => {
            icon.innerHTML = `<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>`;
            btn.style.background = "";
            btn.style.color = "";
        }, 2000);
    });
}

function descargarQR() {
    const canvas = document.querySelector("#qr-container canvas");
    if (!canvas) return;
    const usuario = leerSesion()?.usuario || "asesor";
    const link = document.createElement("a");
    link.download = `QR_Encuesta_${usuario}.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
}


/* ══════════════════════════════════════════════
   ADMIN — POBLAR SELECTORES DE ASESORES
══════════════════════════════════════════════ */
function poblarSelectAsesores() {
    const asesores = [...new Set(allLeads.map(l => l.usuario).filter(Boolean))].sort();
    ["filtro-asesor", "stats-asesor"].forEach(id => {
        const sel = document.getElementById(id);
        if (!sel) return;
        sel.innerHTML = `<option value="todos">Todos los asesores</option>`;
        asesores.forEach(a => {
            const opt = document.createElement("option");
            opt.value = a;
            opt.textContent = a;
            sel.appendChild(opt);
        });
    });
}

/* ══════════════════════════════════════════════
   ADMIN — STATS (Navegación y lógica)
══════════════════════════════════════════════ */
function mostrarEstadisticas() {
    document.getElementById("vista-lista").style.display = "none";
    document.getElementById("vista-stats").style.display = "block";

    const rol = leerSesion()?.rol;
    const agente = leerSesion()?.usuario;

    if (rol === "Administrador") {
        poblarSelectAsesores();
        const sel = document.getElementById("stats-asesor");
        if (sel) sel.value = "todos";
        document.querySelector(".stats-topbar-title").textContent = "Panel de Estadísticas";
    } else {
        const sel = document.getElementById("stats-asesor");
        if (sel) {
            sel.innerHTML = `<option value="${agente}" selected>${agente}</option>`;
            sel.value = agente;
        }
        document.querySelector(".stats-topbar-title").textContent = "Mis Estadísticas";
    }

    currentStatsPeriod = "mes";
    document.querySelectorAll(".sp-btn").forEach(b => b.classList.remove("active"));
    document.getElementById("sp-mes")?.classList.add("active");
    document.getElementById("stats-rango-wrap").style.display = "none";
    calMesAsesor = null;
    renderStats();
    window.scrollTo({ top: 0, behavior: "smooth" });
}

function volverALista() {
    document.getElementById("vista-stats").style.display = "none";
    document.getElementById("vista-lista").style.display = "block";
    window.scrollTo({ top: 0, behavior: "smooth" });
}

let currentStatsPeriod = "mes";

function setStatsPeriod(period, btn) {
    currentStatsPeriod = period;
    document.querySelectorAll(".sp-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    const rangoWrap = document.getElementById("stats-rango-wrap");
    rangoWrap.style.display = period === "rango" ? "block" : "none";

    const hoy = new Date();
    if (period === "hoy" || period === "semana" || period === "mes") {
        calMesAsesor = { year: hoy.getFullYear(), month: hoy.getMonth() };
    }
    if (period !== "rango") renderStats();
}

function getLeadsParaStats() {
    const rol = leerSesion()?.rol;
    const agente = leerSesion()?.usuario || "";
    const asesorSel = document.getElementById("stats-asesor")?.value || "todos";
    const desde = document.getElementById("stats-desde")?.value || "";
    const hasta = document.getElementById("stats-hasta")?.value || "";

    return allLeads.filter(l => {
        let asesorOk;
        if (rol === "Administrador") {
            asesorOk = asesorSel === "todos" || (l.usuario || "").toLowerCase() === asesorSel.toLowerCase();
        } else {
            asesorOk = (l.usuario || "").toLowerCase() === agente.toLowerCase();
        }

        const fl = parseFechaParaFiltro(l.fecha);
        let fechaOk = true;

        if (currentStatsPeriod === "hoy") {
            const b = getLimaBounds("hoy");
            fechaOk = fl ? fl >= b.ini && fl <= b.fin : false;
        } else if (currentStatsPeriod === "semana") {
            const b = getLimaBounds("semana");
            fechaOk = fl ? fl >= b.ini && fl <= b.fin : false;
        } else if (currentStatsPeriod === "mes") {
            const b = getLimaBounds("mes");
            fechaOk = fl ? fl >= b.ini && fl <= b.fin : false;
        } else if (currentStatsPeriod === "rango") {
            if (desde && fl) {
                const [y, m, d] = desde.split("-").map(Number);
                fechaOk = fechaOk && fl >= new Date(Date.UTC(y, m - 1, d, 5, 0, 0, 0));
            }
            if (hasta && fl) {
                const [y, m, d] = hasta.split("-").map(Number);
                fechaOk = fechaOk && fl <= new Date(Date.UTC(y, m - 1, d, 28, 59, 59, 999));
            }
            if (!fl && (desde || hasta)) fechaOk = false;
        }

        return asesorOk && fechaOk;
    });
}

function renderStats() {
    const rol = leerSesion()?.rol;
    const agente = leerSesion()?.usuario;
    const asesorSel = document.getElementById("stats-asesor")?.value || "todos";
    const datos = getLeadsParaStats();
    const container = document.getElementById("stats-content");

    if (rol !== "Administrador") {
        if (!calMesAsesor) { const h = new Date(); calMesAsesor = { year: h.getFullYear(), month: h.getMonth() }; }
        renderStatsAsesor(agente, datos, container);
        return;
    }

    if (asesorSel === "todos") {
        calMesAsesor = null;
        renderStatsGlobal(datos, container);
    } else {
        if (!calMesAsesor) { const h = new Date(); calMesAsesor = { year: h.getFullYear(), month: h.getMonth() }; }
        renderStatsAsesor(asesorSel, datos, container);
    }
}

function renderStatsGlobal(datos, container) {
    const porAsesor = {};
    datos.forEach(l => {
        const key = l.usuario || "—";
        porAsesor[key] = (porAsesor[key] || 0) + 1;
    });

    const ranking = Object.entries(porAsesor).sort((a, b) => b[1] - a[1]);
    const medals = ["🥇", "🥈", "🥉"];
    const topColors = ["#FFD700", "#C0C0C0", "#CD7F32"];
    const maxLeads = ranking[0]?.[1] || 1;
    const periodLabel = { mes: "este mes", semana: "esta semana", hoy: "hoy", rango: "en el rango seleccionado" };

    container.innerHTML = `
    <div class="stats-global">
      <div class="kpi-card kpi-main">
        <div class="kpi-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
        </div>
        <div>
          <div class="kpi-num">${datos.length}</div>
          <div class="kpi-label">leads captados ${periodLabel[currentStatsPeriod] || ""}</div>
        </div>
      </div>
      <div class="kpi-grid">
        <div class="kpi-card kpi-sm">
          <div class="kpi-sm-num">${Object.keys(porAsesor).length}</div>
          <div class="kpi-sm-label">asesores activos</div>
        </div>
        <div class="kpi-card kpi-sm">
          <div class="kpi-sm-num">${Object.keys(porAsesor).length ? Math.round(datos.length / Object.keys(porAsesor).length) : 0}</div>
          <div class="kpi-sm-label">leads promedio / asesor</div>
        </div>
        <div class="kpi-card kpi-sm">
          <div class="kpi-sm-num">${ranking[0]?.[1] || 0}</div>
          <div class="kpi-sm-label">máximo individual</div>
        </div>
      </div>
      ${ranking.length > 0 ? `
      <div class="stats-section-card">
        <div class="stats-section-header">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
          Ranking de Asesores
        </div>
        <div class="ranking-table">
          ${ranking.map(([nombre, count], i) => {
        const esTop = i < 3;
        const medal = esTop ? medals[i] : "";
        const barColor = esTop ? topColors[i] : null;
        return `
            <div class="ranking-row ${esTop ? "ranking-top" : ""}" style="${esTop ? `border-left: 3px solid ${topColors[i]};` : ""}">
              <div class="ranking-pos">${medal || (i + 1)}</div>
              <div class="ranking-avatar" style="${esTop ? `background: linear-gradient(135deg, ${topColors[i]}, ${topColors[i]}cc)` : ""}">${nombre.charAt(0).toUpperCase()}</div>
              <div class="ranking-nombre" style="${esTop ? "font-weight:700; color:var(--slate-900)" : ""}">${nombre}</div>
              <div class="ranking-bar-wrap">
                <div class="ranking-bar" style="width:${Math.round((count / maxLeads) * 100)}%; ${barColor ? `background:${barColor}` : ""}"></div>
              </div>
              <div class="ranking-count" style="${esTop ? `color:${topColors[i]}` : ""}">${count}</div>
            </div>`;
    }).join("")}
        </div>
      </div>` : `
      <div class="empty-state" style="padding:3rem">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        <p>No hay leads en el período seleccionado.</p>
      </div>`}
    </div>`;
}

let chartInstance = null;
let calMesAsesor = null;

function renderStatsAsesor(asesor, datos, container) {
    const todosLeadsAsesor = allLeads.filter(l => (l.usuario || "").toLowerCase() === asesor.toLowerCase());

    const porDiaTodos = {};
    todosLeadsAsesor.forEach(l => {
        const fl = parseFechaParaFiltro(l.fecha);
        if (!fl) return;
        const key = `${String(fl.getDate()).padStart(2, "0")}/${String(fl.getMonth() + 1).padStart(2, "0")}/${fl.getFullYear()}`;
        porDiaTodos[key] = (porDiaTodos[key] || 0) + 1;
    });

    const porDia = {};
    datos.forEach(l => {
        const fl = parseFechaParaFiltro(l.fecha);
        if (!fl) return;
        const key = `${String(fl.getDate()).padStart(2, "0")}/${String(fl.getMonth() + 1).padStart(2, "0")}/${fl.getFullYear()}`;
        porDia[key] = (porDia[key] || 0) + 1;
    });

    const hoy = new Date();
    if (!calMesAsesor) calMesAsesor = { year: hoy.getFullYear(), month: hoy.getMonth() };
    const { year, month } = calMesAsesor;

    const MESES = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
    const DIAS = ["Lu", "Ma", "Mi", "Ju", "Vi", "Sá", "Do"];

    const primerDia = new Date(year, month, 1);
    const ultimoDia = new Date(year, month + 1, 0);
    const offsetInicio = (primerDia.getDay() + 6) % 7;

    let calCells = "";
    const lunesSemana = new Date(hoy);
    lunesSemana.setDate(hoy.getDate() - ((hoy.getDay() + 6) % 7));
    lunesSemana.setHours(0, 0, 0, 0);
    const domingoSemana = new Date(lunesSemana);
    domingoSemana.setDate(lunesSemana.getDate() + 6);
    domingoSemana.setHours(23, 59, 59, 999);

    for (let i = 0; i < offsetInicio; i++) calCells += `<div class="cal-cell cal-empty"></div>`;

    for (let d = 1; d <= ultimoDia.getDate(); d++) {
        const key = `${String(d).padStart(2, "0")}/${String(month + 1).padStart(2, "0")}/${year}`;
        const count = porDiaTodos[key] || 0;
        const fechaCelda = new Date(year, month, d);
        const esHoy = d === hoy.getDate() && month === hoy.getMonth() && year === hoy.getFullYear();
        const esSemana = fechaCelda >= lunesSemana && fechaCelda <= domingoSemana && month === hoy.getMonth() && year === hoy.getFullYear();
        const tieneLeads = count > 0;

        let highlightClass = "";
        if (currentStatsPeriod === "hoy" && esHoy) highlightClass = "cal-highlight-hoy";
        if (currentStatsPeriod === "semana" && esSemana) highlightClass = "cal-highlight-semana";

        calCells += `
      <div class="cal-cell ${tieneLeads ? "cal-active" : ""} ${esHoy ? "cal-today" : ""} ${highlightClass}">
        <span class="cal-day-num">${d}</span>
        ${tieneLeads ? `<span class="cal-count">${count}</span>` : ""}
      </div>`;
    }

    const diasOrdenados = Object.entries(porDia).sort((a, b) => {
        const [da, ma, ya] = a[0].split("/").map(Number);
        const [db, mb, yb] = b[0].split("/").map(Number);
        return new Date(ya, ma - 1, da) - new Date(yb, mb - 1, db);
    });

    let mesOpts = "";
    for (let i = 0; i < 24; i++) {
        const d = new Date(hoy.getFullYear(), hoy.getMonth() - i, 1);
        const y = d.getFullYear();
        const m = d.getMonth();
        const sel = (y === year && m === month) ? "selected" : "";
        mesOpts += `<option value="${y}-${m}" ${sel}>${MESES[m]} ${y}</option>`;
    }

    container.innerHTML = `
    <div class="stats-asesor">
      <div class="kpi-asesor-header">
        <div class="kpi-asesor-avatar">${asesor.charAt(0).toUpperCase()}</div>
        <div>
          <div class="kpi-asesor-nombre">${asesor}</div>
          <div class="kpi-asesor-sub">${datos.length} lead${datos.length !== 1 ? "s" : ""} · ${Object.keys(porDia).length} día${Object.keys(porDia).length !== 1 ? "s" : ""} en campo</div>
        </div>
        <div class="kpi-asesor-badges">
          <div class="kpi-badge"><div class="kpi-badge-num">${datos.length}</div><div class="kpi-badge-label">Total leads</div></div>
          <div class="kpi-badge"><div class="kpi-badge-num">${Object.keys(porDia).length}</div><div class="kpi-badge-label">Días en campo</div></div>
          <div class="kpi-badge"><div class="kpi-badge-num">${Object.keys(porDia).length ? (datos.length / Object.keys(porDia).length).toFixed(1) : 0}</div><div class="kpi-badge-label">Promedio/día</div></div>
        </div>
      </div>
      <div class="stats-section-card">
        <div class="stats-section-header" style="justify-content:space-between; flex-wrap:wrap; gap:8px">
          <div style="display:flex;align-items:center;gap:8px">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
            Calendario de Campo
          </div>
          <div class="cal-mes-nav">
            <button class="cal-nav-btn" onclick="cambiarMesCal(-1)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg></button>
            <select class="cal-mes-select" onchange="seleccionarMesCal(this.value)">${mesOpts}</select>
            <button class="cal-nav-btn" onclick="cambiarMesCal(1)" ${(year === hoy.getFullYear() && month === hoy.getMonth()) ? 'disabled' : ''}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg></button>
          </div>
        </div>
        <div class="calendar-wrap">
          <div class="cal-header">${DIAS.map(d => `<div class="cal-header-cell">${d}</div>`).join("")}</div>
          <div class="cal-grid">${calCells}</div>
          <div class="cal-legend">
            <span class="cal-legend-dot active-dot"></span> Días con leads
            <span class="cal-today-dot"></span> Hoy
            ${currentStatsPeriod === "semana" ? `<span class="cal-legend-dot semana-dot"></span> Esta semana` : ""}
            ${currentStatsPeriod === "hoy" ? `<span class="cal-legend-dot hoy-dot"></span> Hoy (filtro activo)` : ""}
          </div>
        </div>
      </div>
      ${diasOrdenados.length > 0 ? `
      <div class="stats-section-card">
        <div class="stats-section-header">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
          Producción por Salida de Campo (período seleccionado)
        </div>
        <div class="chart-container"><canvas id="chart-produccion"></canvas></div>
        <div class="chart-trend" id="chart-trend"></div>
      </div>` : `
      <div class="stats-section-card">
        <div class="empty-state" style="padding:2rem">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          <p>No hay datos de campo en el período seleccionado.</p>
        </div>
      </div>`}
    </div>`;

    if (diasOrdenados.length > 0) requestAnimationFrame(() => dibujarGrafica(diasOrdenados));
}

function cambiarMesCal(delta) {
    if (!calMesAsesor) { const h = new Date(); calMesAsesor = { year: h.getFullYear(), month: h.getMonth() }; }
    let { year, month } = calMesAsesor;
    month += delta;
    if (month > 11) { month = 0; year++; }
    if (month < 0) { month = 11; year--; }

    const hoy = new Date();
    if (year > hoy.getFullYear() || (year === hoy.getFullYear() && month > hoy.getMonth())) return;

    calMesAsesor = { year, month };
    sincronizarPeriodoConCalendario(year, month);
    renderStats();
}

function seleccionarMesCal(value) {
    const [y, m] = value.split("-").map(Number);
    calMesAsesor = { year: y, month: m };
    sincronizarPeriodoConCalendario(y, m);
    renderStats();
}

function sincronizarPeriodoConCalendario(year, month) {
    const hoy = new Date();
    const esEsteMes = year === hoy.getFullYear() && month === hoy.getMonth();

    if (esEsteMes) {
        currentStatsPeriod = "mes";
    } else {
        currentStatsPeriod = "rango";
        const ini = `${year}-${String(month + 1).padStart(2, "0")}-01`;
        const lastDay = new Date(year, month + 1, 0).getDate();
        const fin = `${year}-${String(month + 1).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
        const desdeEl = document.getElementById("stats-desde");
        const hastaEl = document.getElementById("stats-hasta");
        if (desdeEl) desdeEl.value = ini;
        if (hastaEl) hastaEl.value = fin;
    }

    document.querySelectorAll(".sp-btn").forEach(b => b.classList.remove("active"));
    if (esEsteMes) {
        document.getElementById("sp-mes")?.classList.add("active");
        document.getElementById("stats-rango-wrap").style.display = "none";
    } else {
        document.getElementById("sp-rango")?.classList.add("active");
        document.getElementById("stats-rango-wrap").style.display = "block";
    }
}

function dibujarGrafica(diasOrdenados) {
    const canvas = document.getElementById("chart-produccion");
    if (!canvas) return;

    const labels = diasOrdenados.map(([k]) => { const [d, m] = k.split("/"); return `${d}/${m}`; });
    const valores = diasOrdenados.map(([, v]) => v);

    const n = valores.length;
    let trend = "estable";
    if (n >= 3) {
        const mitad = Math.floor(n / 2);
        const primera = valores.slice(0, mitad).reduce((a, b) => a + b, 0) / mitad;
        const segunda = valores.slice(n - mitad).reduce((a, b) => a + b, 0) / mitad;
        if (segunda > primera * 1.1) trend = "subiendo";
        else if (segunda < primera * 0.9) trend = "bajando";
    }

    const tc = {
        subiendo: { icon: "📈", label: "Producción en tendencia ascendente", color: "#10b981" },
        bajando: { icon: "📉", label: "Producción en tendencia descendente", color: "#ef4444" },
        estable: { icon: "➡️", label: "Producción estable", color: "#007bc3" },
    }[trend];

    const trendEl = document.getElementById("chart-trend");
    if (trendEl) trendEl.innerHTML = `<span class="trend-badge" style="border-color:${tc.color};color:${tc.color}">${tc.icon} ${tc.label}</span>`;

    if (chartInstance) { chartInstance.destroy(); chartInstance = null; }

    const ctx = canvas.getContext("2d");
    chartInstance = new Chart(ctx, {
        type: "line",
        data: {
            labels,
            datasets: [{ label: "Leads por día", data: valores, borderColor: "#005fcc", backgroundColor: "rgba(0,95,204,0.10)", borderWidth: 2.5, pointBackgroundColor: "#005fcc", pointRadius: 5, pointHoverRadius: 7, fill: true, tension: 0.35 }],
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ` ${ctx.raw} lead${ctx.raw !== 1 ? "s" : ""}` } } },
            scales: {
                y: { beginAtZero: true, ticks: { stepSize: 1, font: { family: "Outfit", size: 12 } }, grid: { color: "rgba(0,0,0,0.06)" } },
                x: { ticks: { font: { family: "Outfit", size: 11 } }, grid: { display: false } },
            },
        },
    });
}


/* ══════════════════════════════════════════════
   COTIZADOR
══════════════════════════════════════════════ */
const COT_LISTA_C1 = [
    { plan: "Plan Auna salud Classic", rango: [0, 17], reg: 130.3, prom: 93.80 },
    { plan: "Plan Auna salud Classic", rango: [18, 25], reg: 154.72, prom: 111.38 },
    { plan: "Plan Auna salud Classic", rango: [26, 35], reg: 172.63, prom: 124.28 },
    { plan: "Plan Auna salud Classic", rango: [36, 40], reg: 192.19, prom: 138.36 },
    { plan: "Plan Auna salud Classic", rango: [41, 45], reg: 254.08, prom: 182.91 },
    { plan: "Plan Auna salud Classic", rango: [46, 50], reg: 298.02, prom: 214.55 },
    { plan: "Plan Auna salud Classic", rango: [51, 55], reg: 387.61, prom: 279.03 },
    { plan: "Plan Auna salud Classic", rango: [56, 60], reg: 464.15, prom: 334.14 },
    { plan: "Plan Auna salud Premium", rango: [0, 17], reg: 234.3, prom: 140.56 },
    { plan: "Plan Auna salud Premium", rango: [18, 25], reg: 279.58, prom: 167.71 },
    { plan: "Plan Auna salud Premium", rango: [26, 35], reg: 311.89, prom: 187.1 },
    { plan: "Plan Auna salud Premium", rango: [36, 40], reg: 347.46, prom: 208.45 },
    { plan: "Plan Auna salud Premium", rango: [41, 45], reg: 457.36, prom: 274.37 },
    { plan: "Plan Auna salud Premium", rango: [46, 50], reg: 538.16, prom: 322.85 },
    { plan: "Plan Auna salud Premium", rango: [51, 55], reg: 630.3, prom: 378.12 },
    { plan: "Plan Auna salud Premium", rango: [56, 60], reg: 678.77, prom: 407.19 },
    { plan: "Plan Auna salud Senior", rango: [61, 65], reg: 707.17, prom: 494.95 },
    { plan: "Plan Auna salud Senior", rango: [66, 70], reg: 858.24, prom: 600.68 },
    { plan: "Plan Auna salud Senior", rango: [71, 75], reg: 983.6, prom: 688.42 },
    { plan: "Plan Auna salud Senior", rango: [76, 80], reg: 1129.85, prom: 790.78 },
    { plan: "Plan Auna salud Senior", rango: [81, 120], reg: 1314.66, prom: 920.13 },
    { plan: "Onco Pro", rango: [0, 17], reg: 43.91, prom: 26.34 },
    { plan: "Onco Pro", rango: [18, 25], reg: 47.03, prom: 28.21 },
    { plan: "Onco Pro", rango: [26, 26], reg: 78.92, prom: 43.40 },
    { plan: "Onco Pro", rango: [27, 35], reg: 90.38, prom: 49.70 },
    { plan: "Onco Pro", rango: [36, 40], reg: 92.26, prom: 50.74 },
    { plan: "Onco Pro", rango: [41, 41], reg: 99.82, prom: 54.89 },
    { plan: "Onco Pro", rango: [42, 43], reg: 102.7, prom: 56.47 },
    { plan: "Onco Pro", rango: [44, 45], reg: 104.58, prom: 57.51 },
    { plan: "Onco Pro", rango: [46, 46], reg: 112.29, prom: 61.75 },
    { plan: "Onco Pro", rango: [47, 47], reg: 113.75, prom: 62.55 },
    { plan: "Onco Pro", rango: [48, 48], reg: 115.04, prom: 63.26 },
    { plan: "Onco Pro", rango: [49, 49], reg: 120.53, prom: 66.28 },
    { plan: "Onco Pro", rango: [50, 50], reg: 130.1, prom: 71.54 },
    { plan: "Onco Pro", rango: [51, 51], reg: 141.12, prom: 77.60 },
    { plan: "Onco Pro", rango: [52, 52], reg: 156.85, prom: 86.25 },
    { plan: "Onco Pro", rango: [53, 53], reg: 169.01, prom: 92.94 },
    { plan: "Onco Pro", rango: [54, 54], reg: 176.41, prom: 97.01 },
    { plan: "Onco Pro", rango: [55, 55], reg: 186.44, prom: 102.52 },
    { plan: "Onco Pro", rango: [56, 56], reg: 192.19, prom: 105.68 },
    { plan: "Onco Pro", rango: [57, 57], reg: 205.9, prom: 113.22 },
    { plan: "Onco Pro", rango: [58, 58], reg: 215.63, prom: 118.58 },
    { plan: "Onco Pro", rango: [59, 59], reg: 229.73, prom: 126.33 },
    { plan: "Onco Pro", rango: [60, 60], reg: 243.13, prom: 133.69 },
    { plan: "Onco Pro", rango: [61, 61], reg: 256.98, prom: 141.32 },
    { plan: "Onco Plus", rango: [0, 17], reg: 53.58, prom: 32.14 },
    { plan: "Onco Plus", rango: [18, 25], reg: 57.55, prom: 34.53 },
    { plan: "Onco Plus", rango: [26, 26], reg: 131.72, prom: 72.44 },
    { plan: "Onco Plus", rango: [27, 35], reg: 153.99, prom: 84.68 },
    { plan: "Onco Plus", rango: [36, 36], reg: 160.49, prom: 88.25 },
    { plan: "Onco Plus", rango: [37, 37], reg: 165.38, prom: 90.94 },
    { plan: "Onco Plus", rango: [38, 38], reg: 166.97, prom: 91.82 },
    { plan: "Onco Plus", rango: [39, 39], reg: 169.01, prom: 92.94 },
    { plan: "Onco Plus", rango: [40, 40], reg: 171.3, prom: 94.20 },
    { plan: "Onco Plus", rango: [41, 41], reg: 175.43, prom: 96.47 },
    { plan: "Onco Plus", rango: [42, 42], reg: 178.48, prom: 98.14 },
    { plan: "Onco Plus", rango: [43, 43], reg: 186, prom: 102.28 },
    { plan: "Onco Plus", rango: [44, 44], reg: 188.52, prom: 103.66 },
    { plan: "Onco Plus", rango: [45, 45], reg: 193.85, prom: 106.60 },
    { plan: "Onco Plus", rango: [46, 46], reg: 201.98, prom: 111.07 },
    { plan: "Onco Plus", rango: [47, 47], reg: 208.23, prom: 114.51 },
    { plan: "Onco Plus", rango: [48, 48], reg: 215.93, prom: 118.74 },
    { plan: "Onco Plus", rango: [49, 49], reg: 220.58, prom: 121.29 },
    { plan: "Onco Plus", rango: [50, 50], reg: 234.15, prom: 128.76 },
    { plan: "Onco Plus", rango: [51, 51], reg: 235.96, prom: 129.75 },
    { plan: "Onco Plus", rango: [52, 52], reg: 243.14, prom: 133.71 },
    { plan: "Onco Plus", rango: [53, 53], reg: 247.21, prom: 135.94 },
    { plan: "Onco Plus", rango: [54, 54], reg: 250.51, prom: 137.75 },
    { plan: "Onco Plus", rango: [55, 55], reg: 261.42, prom: 143.75 },
    { plan: "Onco Plus", rango: [56, 56], reg: 276.39, prom: 151.98 },
    { plan: "Onco Plus", rango: [57, 57], reg: 287.44, prom: 158.06 },
    { plan: "Onco Plus", rango: [58, 58], reg: 306.17, prom: 168.36 },
    { plan: "Onco Plus", rango: [59, 59], reg: 321.77, prom: 176.94 },
    { plan: "Onco Plus", rango: [60, 60], reg: 337.16, prom: 185.40 },
];

const COT_LISTA_C2 = [
    { plan: "Plan Auna salud Classic", rango: [0, 17], reg: 130.3, prom: 91.19 },
    { plan: "Plan Auna salud Classic", rango: [18, 25], reg: 154.72, prom: 108.29 },
    { plan: "Plan Auna salud Classic", rango: [26, 35], reg: 172.63, prom: 120.83 },
    { plan: "Plan Auna salud Classic", rango: [36, 40], reg: 192.19, prom: 134.51 },
    { plan: "Plan Auna salud Classic", rango: [41, 45], reg: 254.08, prom: 177.83 },
    { plan: "Plan Auna salud Classic", rango: [46, 50], reg: 298.02, prom: 208.59 },
    { plan: "Plan Auna salud Classic", rango: [51, 55], reg: 387.61, prom: 271.28 },
    { plan: "Plan Auna salud Classic", rango: [56, 60], reg: 464.15, prom: 324.87 },
    { plan: "Plan Auna salud Premium", rango: [0, 17], reg: 234.3, prom: 128.84 },
    { plan: "Plan Auna salud Premium", rango: [18, 25], reg: 279.58, prom: 153.74 },
    { plan: "Plan Auna salud Premium", rango: [26, 35], reg: 311.89, prom: 171.50 },
    { plan: "Plan Auna salud Premium", rango: [36, 40], reg: 347.46, prom: 191.07 },
    { plan: "Plan Auna salud Premium", rango: [41, 45], reg: 457.36, prom: 251.51 },
    { plan: "Plan Auna salud Premium", rango: [46, 50], reg: 538.16, prom: 295.93 },
    { plan: "Plan Auna salud Premium", rango: [51, 55], reg: 630.3, prom: 346.60 },
    { plan: "Plan Auna salud Premium", rango: [56, 60], reg: 678.77, prom: 373.26 },
    { plan: "Plan Auna salud Senior", rango: [61, 65], reg: 707.17, prom: 459.60 },
    { plan: "Plan Auna salud Senior", rango: [66, 70], reg: 858.24, prom: 557.77 },
    { plan: "Plan Auna salud Senior", rango: [71, 75], reg: 983.6, prom: 639.24 },
    { plan: "Plan Auna salud Senior", rango: [76, 80], reg: 1129.85, prom: 734.29 },
    { plan: "Plan Auna salud Senior", rango: [81, 120], reg: 1314.66, prom: 854.40 },
    { plan: "Onco Pro", rango: [0, 17], reg: 43.91, prom: 26.34 },
    { plan: "Onco Pro", rango: [18, 25], reg: 47.03, prom: 28.21 },
    { plan: "Onco Pro", rango: [26, 26], reg: 78.92, prom: 43.40 },
    { plan: "Onco Pro", rango: [27, 35], reg: 90.38, prom: 49.70 },
    { plan: "Onco Pro", rango: [36, 40], reg: 92.26, prom: 50.74 },
    { plan: "Onco Pro", rango: [41, 41], reg: 99.82, prom: 54.89 },
    { plan: "Onco Pro", rango: [42, 43], reg: 102.7, prom: 56.47 },
    { plan: "Onco Pro", rango: [44, 45], reg: 104.58, prom: 57.51 },
    { plan: "Onco Pro", rango: [46, 46], reg: 112.29, prom: 61.75 },
    { plan: "Onco Pro", rango: [47, 47], reg: 113.75, prom: 62.55 },
    { plan: "Onco Pro", rango: [48, 48], reg: 115.04, prom: 63.26 },
    { plan: "Onco Pro", rango: [49, 49], reg: 120.53, prom: 66.28 },
    { plan: "Onco Pro", rango: [50, 50], reg: 130.1, prom: 71.54 },
    { plan: "Onco Pro", rango: [51, 51], reg: 141.12, prom: 77.60 },
    { plan: "Onco Pro", rango: [52, 52], reg: 156.85, prom: 86.25 },
    { plan: "Onco Pro", rango: [53, 53], reg: 169.01, prom: 92.94 },
    { plan: "Onco Pro", rango: [54, 54], reg: 176.41, prom: 97.01 },
    { plan: "Onco Pro", rango: [55, 55], reg: 186.44, prom: 102.52 },
    { plan: "Onco Pro", rango: [56, 56], reg: 192.19, prom: 105.68 },
    { plan: "Onco Pro", rango: [57, 57], reg: 205.9, prom: 113.22 },
    { plan: "Onco Pro", rango: [58, 58], reg: 215.63, prom: 118.58 },
    { plan: "Onco Pro", rango: [59, 59], reg: 229.73, prom: 126.33 },
    { plan: "Onco Pro", rango: [60, 60], reg: 243.13, prom: 133.69 },
    { plan: "Onco Pro", rango: [61, 61], reg: 256.98, prom: 141.32 },
    { plan: "Onco Plus", rango: [0, 17], reg: 53.58, prom: 32.14 },
    { plan: "Onco Plus", rango: [18, 25], reg: 57.55, prom: 34.53 },
    { plan: "Onco Plus", rango: [26, 26], reg: 131.72, prom: 72.44 },
    { plan: "Onco Plus", rango: [27, 35], reg: 153.99, prom: 84.68 },
    { plan: "Onco Plus", rango: [36, 36], reg: 160.49, prom: 88.25 },
    { plan: "Onco Plus", rango: [37, 37], reg: 165.38, prom: 90.94 },
    { plan: "Onco Plus", rango: [38, 38], reg: 166.97, prom: 91.82 },
    { plan: "Onco Plus", rango: [39, 39], reg: 169.01, prom: 92.94 },
    { plan: "Onco Plus", rango: [40, 40], reg: 171.3, prom: 94.20 },
    { plan: "Onco Plus", rango: [41, 41], reg: 175.43, prom: 96.47 },
    { plan: "Onco Plus", rango: [42, 42], reg: 178.48, prom: 98.14 },
    { plan: "Onco Plus", rango: [43, 43], reg: 186, prom: 102.28 },
    { plan: "Onco Plus", rango: [44, 44], reg: 188.52, prom: 103.66 },
    { plan: "Onco Plus", rango: [45, 45], reg: 193.85, prom: 106.60 },
    { plan: "Onco Plus", rango: [46, 46], reg: 201.98, prom: 111.07 },
    { plan: "Onco Plus", rango: [47, 47], reg: 208.23, prom: 114.51 },
    { plan: "Onco Plus", rango: [48, 48], reg: 215.93, prom: 118.74 },
    { plan: "Onco Plus", rango: [49, 49], reg: 220.58, prom: 121.29 },
    { plan: "Onco Plus", rango: [50, 50], reg: 234.15, prom: 128.76 },
    { plan: "Onco Plus", rango: [51, 51], reg: 235.96, prom: 129.75 },
    { plan: "Onco Plus", rango: [52, 52], reg: 243.14, prom: 133.71 },
    { plan: "Onco Plus", rango: [53, 53], reg: 247.21, prom: 135.94 },
    { plan: "Onco Plus", rango: [54, 54], reg: 250.51, prom: 137.75 },
    { plan: "Onco Plus", rango: [55, 55], reg: 261.42, prom: 143.75 },
    { plan: "Onco Plus", rango: [56, 56], reg: 276.39, prom: 151.98 },
    { plan: "Onco Plus", rango: [57, 57], reg: 287.44, prom: 158.06 },
    { plan: "Onco Plus", rango: [58, 58], reg: 306.17, prom: 168.36 },
    { plan: "Onco Plus", rango: [59, 59], reg: 321.77, prom: 176.94 },
    { plan: "Onco Plus", rango: [60, 60], reg: 337.16, prom: 185.40 },
];

const COT_LISTA_D1 = [
    { plan: "Plan Auna salud Classic", rango: [0, 17], reg: 143.32, prom: 103.18 },
    { plan: "Plan Auna salud Classic", rango: [18, 25], reg: 170.19, prom: 122.52 },
    { plan: "Plan Auna salud Classic", rango: [26, 35], reg: 189.90, prom: 136.70 },
    { plan: "Plan Auna salud Classic", rango: [36, 40], reg: 211.41, prom: 152.20 },
    { plan: "Plan Auna salud Classic", rango: [41, 45], reg: 279.48, prom: 201.20 },
    { plan: "Plan Auna salud Classic", rango: [46, 50], reg: 327.83, prom: 236.00 },
    { plan: "Plan Auna salud Classic", rango: [51, 55], reg: 426.37, prom: 306.94 },
    { plan: "Plan Auna salud Classic", rango: [56, 60], reg: 510.57, prom: 367.56 },
    { plan: "Plan Auna salud Premium", rango: [0, 17], reg: 257.74, prom: 154.62 },
    { plan: "Plan Auna salud Premium", rango: [18, 25], reg: 307.53, prom: 184.49 },
    { plan: "Plan Auna salud Premium", rango: [26, 35], reg: 343.07, prom: 205.80 },
    { plan: "Plan Auna salud Premium", rango: [36, 40], reg: 382.21, prom: 229.29 },
    { plan: "Plan Auna salud Premium", rango: [41, 45], reg: 503.09, prom: 301.81 },
    { plan: "Plan Auna salud Premium", rango: [46, 50], reg: 591.98, prom: 355.13 },
    { plan: "Plan Auna salud Premium", rango: [51, 55], reg: 693.33, prom: 415.93 },
    { plan: "Plan Auna salud Premium", rango: [56, 60], reg: 746.65, prom: 447.92 },
    { plan: "Plan Auna salud Senior", rango: [61, 65], reg: 777.89, prom: 544.45 },
    { plan: "Plan Auna salud Senior", rango: [66, 70], reg: 944.06, prom: 660.74 },
    { plan: "Plan Auna salud Senior", rango: [71, 75], reg: 1081.97, prom: 757.27 },
    { plan: "Plan Auna salud Senior", rango: [76, 80], reg: 1242.84, prom: 869.86 },
    { plan: "Plan Auna salud Senior", rango: [81, 120], reg: 1446.13, prom: 1012.15 },
    { plan: "Onco Pro", rango: [0, 17], reg: 52.69, prom: 31.61 },
    { plan: "Onco Pro", rango: [18, 25], reg: 56.44, prom: 33.85 },
    { plan: "Onco Pro", rango: [26, 26], reg: 94.71, prom: 52.07 },
    { plan: "Onco Pro", rango: [27, 35], reg: 108.45, prom: 59.64 },
    { plan: "Onco Pro", rango: [36, 40], reg: 110.72, prom: 60.89 },
    { plan: "Onco Pro", rango: [41, 41], reg: 119.78, prom: 65.87 },
    { plan: "Onco Pro", rango: [42, 43], reg: 123.24, prom: 67.77 },
    { plan: "Onco Pro", rango: [44, 45], reg: 125.50, prom: 69.02 },
    { plan: "Onco Pro", rango: [46, 46], reg: 134.74, prom: 74.09 },
    { plan: "Onco Pro", rango: [47, 47], reg: 136.50, prom: 75.06 },
    { plan: "Onco Pro", rango: [48, 48], reg: 138.05, prom: 75.91 },
    { plan: "Onco Pro", rango: [49, 49], reg: 144.63, prom: 79.53 },
    { plan: "Onco Pro", rango: [50, 50], reg: 156.11, prom: 85.85 },
    { plan: "Onco Pro", rango: [51, 51], reg: 169.34, prom: 93.13 },
    { plan: "Onco Pro", rango: [52, 52], reg: 188.21, prom: 103.50 },
    { plan: "Onco Pro", rango: [53, 53], reg: 202.82, prom: 111.53 },
    { plan: "Onco Pro", rango: [54, 54], reg: 211.69, prom: 116.41 },
    { plan: "Onco Pro", rango: [55, 55], reg: 223.73, prom: 123.03 },
    { plan: "Onco Pro", rango: [56, 56], reg: 230.62, prom: 126.81 },
    { plan: "Onco Pro", rango: [57, 57], reg: 247.08, prom: 135.87 },
    { plan: "Onco Pro", rango: [58, 58], reg: 258.76, prom: 142.30 },
    { plan: "Onco Pro", rango: [59, 59], reg: 275.68, prom: 151.59 },
    { plan: "Onco Pro", rango: [60, 60], reg: 291.76, prom: 160.43 },
    { plan: "Onco Pro", rango: [61, 61], reg: 308.38, prom: 169.58 },
    { plan: "Onco Plus", rango: [0, 17], reg: 64.3, prom: 38.57 },
    { plan: "Onco Plus", rango: [18, 25], reg: 69.05, prom: 41.43 },
    { plan: "Onco Plus", rango: [26, 26], reg: 158.07, prom: 86.92 },
    { plan: "Onco Plus", rango: [27, 35], reg: 184.79, prom: 101.61 },
    { plan: "Onco Plus", rango: [36, 36], reg: 192.59, prom: 105.91 },
    { plan: "Onco Plus", rango: [37, 37], reg: 198.45, prom: 109.13 },
    { plan: "Onco Plus", rango: [38, 38], reg: 200.36, prom: 110.18 },
    { plan: "Onco Plus", rango: [39, 39], reg: 202.82, prom: 111.53 },
    { plan: "Onco Plus", rango: [40, 40], reg: 205.56, prom: 113.03 },
    { plan: "Onco Plus", rango: [41, 41], reg: 210.51, prom: 115.76 },
    { plan: "Onco Plus", rango: [42, 42], reg: 214.17, prom: 117.78 },
    { plan: "Onco Plus", rango: [43, 43], reg: 223.21, prom: 122.74 },
    { plan: "Onco Plus", rango: [44, 44], reg: 226.22, prom: 124.40 },
    { plan: "Onco Plus", rango: [45, 45], reg: 232.63, prom: 127.92 },
    { plan: "Onco Plus", rango: [46, 46], reg: 242.37, prom: 133.28 },
    { plan: "Onco Plus", rango: [47, 47], reg: 249.88, prom: 137.41 },
    { plan: "Onco Plus", rango: [48, 48], reg: 259.12, prom: 142.49 },
    { plan: "Onco Plus", rango: [49, 49], reg: 264.7, prom: 145.55 },
    { plan: "Onco Plus", rango: [50, 50], reg: 280.98, prom: 154.51 },
    { plan: "Onco Plus", rango: [51, 51], reg: 283.15, prom: 155.70 },
    { plan: "Onco Plus", rango: [52, 52], reg: 291.77, prom: 160.44 },
    { plan: "Onco Plus", rango: [53, 53], reg: 296.65, prom: 163.12 },
    { plan: "Onco Plus", rango: [54, 54], reg: 300.62, prom: 165.31 },
    { plan: "Onco Plus", rango: [55, 55], reg: 313.7, prom: 172.50 },
    { plan: "Onco Plus", rango: [56, 56], reg: 331.67, prom: 182.39 },
    { plan: "Onco Plus", rango: [57, 57], reg: 344.93, prom: 189.67 },
    { plan: "Onco Plus", rango: [58, 58], reg: 367.4, prom: 202.04 },
    { plan: "Onco Plus", rango: [59, 59], reg: 386.13, prom: 212.33 },
    { plan: "Onco Plus", rango: [60, 60], reg: 404.6, prom: 222.49 },
];
const COT_LISTA_D2 = [
    { plan: "Plan Auna salud Classic", rango: [0, 17], reg: 143.32, prom: 100.31 },
    { plan: "Plan Auna salud Classic", rango: [18, 25], reg: 170.19, prom: 119.12 },
    { plan: "Plan Auna salud Classic", rango: [26, 35], reg: 189.90, prom: 132.90 },
    { plan: "Plan Auna salud Classic", rango: [36, 40], reg: 211.41, prom: 147.96 },
    { plan: "Plan Auna salud Classic", rango: [41, 45], reg: 279.48, prom: 195.61 },
    { plan: "Plan Auna salud Classic", rango: [46, 50], reg: 327.83, prom: 229.45 },
    { plan: "Plan Auna salud Classic", rango: [51, 55], reg: 426.37, prom: 298.41 },
    { plan: "Plan Auna salud Classic", rango: [56, 60], reg: 510.57, prom: 357.35 },
    { plan: "Plan Auna salud Premium", rango: [0, 17], reg: 257.74, prom: 141.73 },
    { plan: "Plan Auna salud Premium", rango: [18, 25], reg: 307.53, prom: 169.11 },
    { plan: "Plan Auna salud Premium", rango: [26, 35], reg: 343.07, prom: 188.66 },
    { plan: "Plan Auna salud Premium", rango: [36, 40], reg: 382.21, prom: 210.18 },
    { plan: "Plan Auna salud Premium", rango: [41, 45], reg: 503.09, prom: 276.65 },
    { plan: "Plan Auna salud Premium", rango: [46, 50], reg: 591.98, prom: 325.53 },
    { plan: "Plan Auna salud Premium", rango: [51, 55], reg: 693.33, prom: 381.26 },
    { plan: "Plan Auna salud Premium", rango: [56, 60], reg: 746.65, prom: 410.58 },
    { plan: "Plan Auna salud Senior", rango: [61, 65], reg: 777.89, prom: 505.55 },
    { plan: "Plan Auna salud Senior", rango: [66, 70], reg: 944.06, prom: 613.54 },
    { plan: "Plan Auna salud Senior", rango: [71, 75], reg: 1081.97, prom: 703.17 },
    { plan: "Plan Auna salud Senior", rango: [76, 80], reg: 1242.84, prom: 807.72 },
    { plan: "Plan Auna salud Senior", rango: [81, 120], reg: 1446.13, prom: 939.83 },
    { plan: "Onco Pro", rango: [0, 17], reg: 52.69, prom: 31.61 },
    { plan: "Onco Pro", rango: [18, 25], reg: 56.44, prom: 33.85 },
    { plan: "Onco Pro", rango: [26, 26], reg: 94.71, prom: 52.07 },
    { plan: "Onco Pro", rango: [27, 35], reg: 108.45, prom: 59.64 },
    { plan: "Onco Pro", rango: [36, 40], reg: 110.72, prom: 60.89 },
    { plan: "Onco Pro", rango: [41, 41], reg: 119.78, prom: 65.87 },
    { plan: "Onco Pro", rango: [42, 43], reg: 123.24, prom: 67.77 },
    { plan: "Onco Pro", rango: [44, 45], reg: 125.50, prom: 69.02 },
    { plan: "Onco Pro", rango: [46, 46], reg: 134.74, prom: 74.09 },
    { plan: "Onco Pro", rango: [47, 47], reg: 136.50, prom: 75.06 },
    { plan: "Onco Pro", rango: [48, 48], reg: 138.05, prom: 75.91 },
    { plan: "Onco Pro", rango: [49, 49], reg: 144.63, prom: 79.53 },
    { plan: "Onco Pro", rango: [50, 50], reg: 156.11, prom: 85.85 },
    { plan: "Onco Pro", rango: [51, 51], reg: 169.34, prom: 93.13 },
    { plan: "Onco Pro", rango: [52, 52], reg: 188.21, prom: 103.50 },
    { plan: "Onco Pro", rango: [53, 53], reg: 202.82, prom: 111.53 },
    { plan: "Onco Pro", rango: [54, 54], reg: 211.69, prom: 116.41 },
    { plan: "Onco Pro", rango: [55, 55], reg: 223.73, prom: 123.03 },
    { plan: "Onco Pro", rango: [56, 56], reg: 230.62, prom: 126.81 },
    { plan: "Onco Pro", rango: [57, 57], reg: 247.08, prom: 135.87 },
    { plan: "Onco Pro", rango: [58, 58], reg: 258.76, prom: 142.30 },
    { plan: "Onco Pro", rango: [59, 59], reg: 275.68, prom: 151.59 },
    { plan: "Onco Pro", rango: [60, 60], reg: 291.76, prom: 160.43 },
    { plan: "Onco Pro", rango: [61, 61], reg: 308.38, prom: 169.58 },
    { plan: "Onco Plus", rango: [0, 17], reg: 64.3, prom: 38.57 },
    { plan: "Onco Plus", rango: [18, 25], reg: 69.05, prom: 41.43 },
    { plan: "Onco Plus", rango: [26, 26], reg: 158.07, prom: 86.92 },
    { plan: "Onco Plus", rango: [27, 35], reg: 184.79, prom: 101.61 },
    { plan: "Onco Plus", rango: [36, 36], reg: 192.59, prom: 105.91 },
    { plan: "Onco Plus", rango: [37, 37], reg: 198.45, prom: 109.13 },
    { plan: "Onco Plus", rango: [38, 38], reg: 200.36, prom: 110.18 },
    { plan: "Onco Plus", rango: [39, 39], reg: 202.82, prom: 111.53 },
    { plan: "Onco Plus", rango: [40, 40], reg: 205.56, prom: 113.03 },
    { plan: "Onco Plus", rango: [41, 41], reg: 210.51, prom: 115.76 },
    { plan: "Onco Plus", rango: [42, 42], reg: 214.17, prom: 117.78 },
    { plan: "Onco Plus", rango: [43, 43], reg: 223.21, prom: 122.74 },
    { plan: "Onco Plus", rango: [44, 44], reg: 226.22, prom: 124.40 },
    { plan: "Onco Plus", rango: [45, 45], reg: 232.63, prom: 127.92 },
    { plan: "Onco Plus", rango: [46, 46], reg: 242.37, prom: 133.28 },
    { plan: "Onco Plus", rango: [47, 47], reg: 249.88, prom: 137.41 },
    { plan: "Onco Plus", rango: [48, 48], reg: 259.12, prom: 142.49 },
    { plan: "Onco Plus", rango: [49, 49], reg: 264.7, prom: 145.55 },
    { plan: "Onco Plus", rango: [50, 50], reg: 280.98, prom: 154.51 },
    { plan: "Onco Plus", rango: [51, 51], reg: 283.15, prom: 155.70 },
    { plan: "Onco Plus", rango: [52, 52], reg: 291.77, prom: 160.44 },
    { plan: "Onco Plus", rango: [53, 53], reg: 296.65, prom: 163.12 },
    { plan: "Onco Plus", rango: [54, 54], reg: 300.62, prom: 165.31 },
    { plan: "Onco Plus", rango: [55, 55], reg: 313.7, prom: 172.50 },
    { plan: "Onco Plus", rango: [56, 56], reg: 331.67, prom: 182.39 },
    { plan: "Onco Plus", rango: [57, 57], reg: 344.93, prom: 189.67 },
    { plan: "Onco Plus", rango: [58, 58], reg: 367.4, prom: 202.04 },
    { plan: "Onco Plus", rango: [59, 59], reg: 386.13, prom: 212.33 },
    { plan: "Onco Plus", rango: [60, 60], reg: 404.6, prom: 222.49 },
];

function cot_getTarifario() {
    if (cot_modoPago === "credito") {
        return cot_currentInt === 1 ? COT_LISTA_C1 : COT_LISTA_C2;
    } else {
        return cot_currentInt === 1 ? COT_LISTA_D1 : COT_LISTA_D2;
    }
}

let cot_modoPanel = "asesor";
let cot_currentInt = 1;
let cot_modoActuarial = false;
let cot_modoPago = "credito";
let cot_initialised = false;

function cot_init() {
    if (cot_initialised) return;
    cot_initialised = true;
    const hoy = new Date().toISOString().split("T")[0];
    document.getElementById("cot_fechaLimite").value = hoy;
    cot_renderizarCampos();
    cot_ajustarEscala();
    window.addEventListener("resize", cot_ajustarEscala);
}

function cot_ajustarEscala() {
    const wrap = document.querySelector(".cot-preview-wrap");
    const scaler = document.querySelector(".cot-preview-scaler");
    const card = document.getElementById("cot_cotizacion-final");
    if (!wrap || !scaler || !card) return;

    const cardW = 450;
    const cardH = card.scrollHeight || 700;
    const anchoDisponible = wrap.clientWidth || 400;
    const alturaDisponible = (window.innerHeight - 64 - 32) || 500;
    const escalaPorAncho = anchoDisponible / cardW;
    const escalaPorAltura = alturaDisponible / cardH;
    const escala = Math.min(escalaPorAncho, escalaPorAltura, 1);

    scaler.style.transform = `scale(${escala})`;
    scaler.style.transformOrigin = "top center";
    const alturaReal = Math.round(cardH * escala);
    wrap.style.height = alturaReal + "px";
    wrap.style.overflow = "hidden";
}

function cot_calcularEdadActuarial(fechaNac) {
    if (!fechaNac) return null;
    const hoy = new Date();
    const nac = new Date(fechaNac + "T00:00:00");
    if (isNaN(nac)) return null;
    let años = hoy.getFullYear() - nac.getFullYear();
    const yaCompleto = hoy.getMonth() > nac.getMonth() ||
        (hoy.getMonth() === nac.getMonth() && hoy.getDate() >= nac.getDate());
    if (!yaCompleto) años--;
    let ultimo = new Date(hoy.getFullYear(), nac.getMonth(), nac.getDate());
    if (!yaCompleto) ultimo = new Date(hoy.getFullYear() - 1, nac.getMonth(), nac.getDate());
    const proximo = new Date(ultimo); proximo.setFullYear(proximo.getFullYear() + 1);
    const fraccion = (hoy - ultimo) / (proximo - ultimo);
    return Math.round(años + fraccion);
}

function cot_toggleActuarial() {
    cot_modoActuarial = !cot_modoActuarial;
    const btn = document.getElementById("cot_btnActuarial");
    const status = document.getElementById("cot_actuarial-status");
    if (cot_modoActuarial) {
        btn.classList.add("active");
        status.textContent = "Activado";
        status.classList.remove("cot-status-off");
        status.classList.add("cot-status-on");
    } else {
        btn.classList.remove("active");
        status.textContent = "Off";
        status.classList.remove("cot-status-on");
        status.classList.add("cot-status-off");
    }
    cot_renderizarCampos();
}

function cot_togglePago() {
    cot_modoPago = cot_modoPago === "credito" ? "debito" : "credito";
    const btn = document.getElementById("cot_btnPago");
    const status = document.getElementById("cot_pago-status");
    if (cot_modoPago === "debito") {
        btn.classList.add("active");
        status.textContent = "Débito";
        status.classList.remove("cot-status-off");
        status.classList.add("cot-status-on");
    } else {
        btn.classList.remove("active");
        status.textContent = "Crédito";
        status.classList.remove("cot-status-on");
        status.classList.add("cot-status-off");
    }
    // Recalcular precios con la nueva lista
    cot_actualizarTodoPorPlan();
}

function cot_toggleMenuModo() {
    const menu = document.getElementById("cot_menuModo");
    const chevron = document.getElementById("cot_chevronModo");
    menu.classList.toggle("hidden");
    chevron.style.transform = menu.classList.contains("hidden") ? "" : "rotate(180deg)";
}

function cot_seleccionarModo(modo) {
    cot_modoPanel = modo;
    document.getElementById("cot_menuModo").classList.add("hidden");
    document.getElementById("cot_chevronModo").style.transform = "";
    document.getElementById("cot_tituloPanel").textContent =
        modo === "asesor" ? "Panel del Asesor" : "Cotización de cliente";
    document.getElementById("cot_botonesAsesor").classList.toggle("hidden", modo !== "asesor");
    document.getElementById("cot_botonesCliente").classList.toggle("hidden", modo !== "cliente");
    cot_renderizarCampos();
}

function cot_cambiarIntegrantes(delta) {
    const nuevo = cot_currentInt + delta;
    if (nuevo < 1 || nuevo > 4) return;
    const antes = cot_currentInt;
    cot_currentInt = nuevo;
    document.getElementById("cot_contadorDisplay").textContent = cot_currentInt;
    cot_renderizarCampos();
    if ((antes === 1 && nuevo > 1) || (antes > 1 && nuevo === 1)) {
        for (let i = 1; i <= cot_currentInt; i++) cot_autocompletarPrecios(i);
    }
}

function cot_renderizarCampos() {
    const wrap = document.getElementById("cot_contenedorIntegrantes");
    const vals = [];
    for (let i = 1; i <= 4; i++) vals.push({
        edad: document.getElementById("cot_edad-" + i)?.value || "",
        fnac: document.getElementById("cot_fnac-" + i)?.value || "",
        reg: document.getElementById("cot_reg-" + i)?.value || "0.00",
        prom: document.getElementById("cot_prom-" + i)?.value || "0.00",
    });

    wrap.innerHTML = "";
    const esCliente = cot_modoPanel === "cliente";

    for (let i = 1; i <= cot_currentInt; i++) {
        const v = vals[i - 1];
        let html = '<div class="cot-integrante-box">';

        if (cot_modoActuarial) {
            html += '<div><p class="cot-integrante-label">Fecha de Nacimiento</p>'
                + '<input type="date" id="cot_fnac-' + i + '" value="' + v.fnac + '" oninput="cot_autocompletarPrecios(' + i + ')" class="cot-input-date-nac"></div>';
            if (esCliente) {
                html += '<div class="cot-col-grid-2">'
                    + '<div><p class="cot-integrante-label cyan">Edad Actuarial</p>'
                    + '<div class="cot-edad-actuarial-display"><span id="cot_edad-display-' + i + '">--</span></div></div>'
                    + '<div><p class="cot-integrante-label">Regular</p>'
                    + '<input type="text" id="cot_reg-' + i + '" value="' + v.reg + '" readonly class="cot-input-locked"></div>'
                    + '</div><input type="hidden" id="cot_prom-' + i + '" value="' + v.prom + '">';
            } else {
                html += '<div class="cot-col-grid-3">'
                    + '<div><p class="cot-integrante-label cyan">Edad Actuarial</p>'
                    + '<div class="cot-edad-actuarial-display"><span id="cot_edad-display-' + i + '">--</span></div></div>'
                    + '<div><p class="cot-integrante-label">Regular</p>'
                    + '<input type="text" id="cot_reg-' + i + '" value="' + v.reg + '" readonly class="cot-input-locked"></div>'
                    + '<div><p class="cot-integrante-label cyan">Promo</p>'
                    + '<input type="text" id="cot_prom-' + i + '" value="' + v.prom + '" readonly class="cot-input-locked cyan"></div>'
                    + '</div>';
            }
        } else {
            if (esCliente) {
                html += '<div class="cot-col-grid-2">'
                    + '<div><p class="cot-integrante-label">Edad</p>'
                    + '<input type="text" inputmode="numeric" id="cot_edad-' + i + '" value="' + v.edad + '" oninput="cot_autocompletarPrecios(' + i + ')" placeholder="Ej: 35" class="cot-input-edad"></div>'
                    + '<div><p class="cot-integrante-label">Regular</p>'
                    + '<input type="text" id="cot_reg-' + i + '" value="' + v.reg + '" readonly class="cot-input-locked"></div>'
                    + '</div><input type="hidden" id="cot_prom-' + i + '" value="' + v.prom + '">';
            } else {
                html += '<div class="cot-col-grid-3">'
                    + '<div><p class="cot-integrante-label">Edad</p>'
                    + '<input type="text" inputmode="numeric" id="cot_edad-' + i + '" value="' + v.edad + '" oninput="cot_autocompletarPrecios(' + i + ')" placeholder="Ej: 35" class="cot-input-edad"></div>'
                    + '<div><p class="cot-integrante-label">Regular</p>'
                    + '<input type="text" id="cot_reg-' + i + '" value="' + v.reg + '" readonly class="cot-input-locked"></div>'
                    + '<div><p class="cot-integrante-label cyan">Promo</p>'
                    + '<input type="text" id="cot_prom-' + i + '" value="' + v.prom + '" readonly class="cot-input-locked cyan"></div>'
                    + '</div>';
            }
        }
        html += '<p id="cot_error-' + i + '" class="cot-error"></p></div>';
        wrap.innerHTML += html;
    }

    if (cot_modoActuarial) {
        for (let i = 1; i <= cot_currentInt; i++) {
            if (vals[i - 1].fnac) cot_autocompletarPrecios(i);
        }
    }
    cot_actualizarPreview();
}

function cot_autocompletarPrecios(id) {
    const plan = document.getElementById("cot_planGlobal").value;
    const regEl = document.getElementById("cot_reg-" + id);
    const promEl = document.getElementById("cot_prom-" + id);
    const errorEl = document.getElementById("cot_error-" + id);
    if (!errorEl) return;
    errorEl.textContent = "";

    let edad;
    if (cot_modoActuarial) {
        const fnac = document.getElementById("cot_fnac-" + id)?.value;
        if (!fnac) { regEl.value = "0.00"; promEl.value = "0.00"; cot_actualizarPreview(); return; }
        edad = cot_calcularEdadActuarial(fnac);
        if (edad === null) { regEl.value = "0.00"; promEl.value = "0.00"; cot_actualizarPreview(); return; }
        const disp = document.getElementById("cot_edad-display-" + id);
        if (disp) disp.textContent = edad + " años";
    } else {
        const eStr = document.getElementById("cot_edad-" + id)?.value || "";
        edad = parseInt(eStr.replace(/\D/g, ""));
        if (isNaN(edad)) { regEl.value = "0.00"; promEl.value = "0.00"; cot_actualizarPreview(); return; }
    }

    let valid = true;
    if (plan === "Plan Auna salud Senior") {
        if (edad <= 60) { errorEl.textContent = "Mínimo 61 años"; valid = false; }
    } else {
        if (edad > 60) { errorEl.textContent = "Máximo 60 años"; valid = false; }
    }

    if (valid) {
        const match = cot_getTarifario().find(t => t.plan === plan && edad >= t.rango[0] && edad <= t.rango[1]);
        regEl.value = match ? match.reg.toFixed(2) : "0.00";
        promEl.value = match ? match.prom.toFixed(2) : "0.00";
    } else {
        regEl.value = "0.00"; promEl.value = "0.00";
    }
    cot_actualizarPreview();
}

function cot_actualizarTodoPorPlan() {
    for (let i = 1; i <= cot_currentInt; i++) cot_autocompletarPrecios(i);
}

function cot_formatearFecha(str) {
    if (!str) return "fin de mes";
    return new Date(str + "T12:00:00").toLocaleDateString("es-ES", { day: "numeric", month: "long" });
}

// Caché de CSS de fuentes embedidas
let _fontFaceCSS = null;

async function cot_cargarFuentesBase64() {
    if (_fontFaceCSS) return _fontFaceCSS;

    // URLs verificadas directamente de la API de Google Fonts (formato TTF)
    const fontFiles = [
        // Outfit v15
        { url: 'https://fonts.gstatic.com/s/outfit/v15/QGYyz_MVcBeNP4NjuGObqx1XmO1I4TC1C4E.ttf', family: 'Outfit', weight: '400', format: 'truetype' },
        { url: 'https://fonts.gstatic.com/s/outfit/v15/QGYyz_MVcBeNP4NjuGObqx1XmO1I4e6yC4E.ttf', family: 'Outfit', weight: '600', format: 'truetype' },
        { url: 'https://fonts.gstatic.com/s/outfit/v15/QGYyz_MVcBeNP4NjuGObqx1XmO1I4deyC4E.ttf', family: 'Outfit', weight: '700', format: 'truetype' },
        { url: 'https://fonts.gstatic.com/s/outfit/v15/QGYyz_MVcBeNP4NjuGObqx1XmO1I4bCyC4E.ttf', family: 'Outfit', weight: '800', format: 'truetype' },
        // Inter v20
        { url: 'https://fonts.gstatic.com/s/inter/v20/UcCO3FwrK3iLTeHuS_nVMrMxCp50SjIw2boKoduKmMEVuLyfMZg.ttf', family: 'Inter', weight: '400', format: 'truetype' },
        { url: 'https://fonts.gstatic.com/s/inter/v20/UcCO3FwrK3iLTeHuS_nVMrMxCp50SjIw2boKoduKmMEVuGKYMZg.ttf', family: 'Inter', weight: '600', format: 'truetype' },
        { url: 'https://fonts.gstatic.com/s/inter/v20/UcCO3FwrK3iLTeHuS_nVMrMxCp50SjIw2boKoduKmMEVuFuYMZg.ttf', family: 'Inter', weight: '700', format: 'truetype' },
        { url: 'https://fonts.gstatic.com/s/inter/v20/UcCO3FwrK3iLTeHuS_nVMrMxCp50SjIw2boKoduKmMEVuDyYMZg.ttf', family: 'Inter', weight: '800', format: 'truetype' },
    ];

    const toBase64 = async ({ url, family, weight, format }) => {
        try {
            const res = await fetch(url);
            const blob = await res.blob();
            return new Promise((resolve) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(
                    `@font-face { font-family: '${family}'; font-style: normal; font-weight: ${weight}; src: url('${reader.result}') format('${format}'); }`
                );
                reader.readAsDataURL(blob);
            });
        } catch (e) {
            console.warn('Font load failed:', url);
            return '';
        }
    };

    const rules = await Promise.all(fontFiles.map(toBase64));
    _fontFaceCSS = rules.filter(Boolean).join('\n');
    return _fontFaceCSS;
}

function cot_actualizarPreview() {
    const esCliente = cot_modoPanel === "cliente";
    const planEl = document.getElementById("cot_planGlobal");
    if (!planEl) return;
    document.getElementById("cot_prev-plan").textContent = planEl.value;

    const fechaStr = document.getElementById("cot_fechaLimite").value;
    document.getElementById("cot_texto-vence").textContent = "Vence el " + cot_formatearFecha(fechaStr);

    const beneficio = document.getElementById("cot_beneficio").value.trim();
    const areaBenef = document.getElementById("cot_area-beneficio");
    if (beneficio) {
        areaBenef.classList.remove("hidden");
        document.getElementById("cot_prev-beneficio").textContent = beneficio;
    } else {
        areaBenef.classList.add("hidden");
    }

    document.getElementById("cot_bloque-descuento").classList.toggle("hidden", esCliente);
    document.getElementById("cot_bloque-regular").classList.toggle("hidden", !esCliente);

    let tR = 0, tP = 0;
    const lista = document.getElementById("cot_lista-detallada");
    lista.innerHTML = "";

    for (let i = 1; i <= cot_currentInt; i++) {
        let etiquetaEdad;
        if (cot_modoActuarial) {
            const disp = document.getElementById("cot_edad-display-" + i);
            etiquetaEdad = disp ? disp.textContent : "?";
            if (etiquetaEdad === "--") etiquetaEdad = "? años";
        } else {
            const e = document.getElementById("cot_edad-" + i)?.value || "?";
            etiquetaEdad = e + " años";
        }
        const r = parseFloat(document.getElementById("cot_reg-" + i)?.value || 0);
        const p = parseFloat(document.getElementById("cot_prom-" + i)?.value || 0);
        tR += r; tP += p;

        let html = '<div class="cot-lista-item"><span class="cot-lista-name">Integrante ' + i + ' (' + etiquetaEdad + ')</span><div class="cot-lista-price-wrap">';
        if (esCliente) {
            html += '<span class="cot-lista-reg-only"><span class="cot-symbol">S/</span>' + r.toFixed(2) + '</span>';
        } else {
            html += '<span class="cot-lista-reg-through block"><span class="cot-symbol">S/</span>' + r.toFixed(2) + '</span>'
                + '<span class="cot-lista-promo"><span class="cot-symbol">S/</span>' + p.toFixed(2) + '</span>';
        }
        html += '</div></div>';
        lista.innerHTML += html;
    }

    document.getElementById("cot_total-reg").innerHTML = '<span class="cot-symbol">S/</span>' + tR.toFixed(2);
    document.getElementById("cot_total-promo").innerHTML = '<span class="cot-symbol">S/</span>' + tP.toFixed(2);
    document.getElementById("cot_total-solo-reg").innerHTML = '<span class="cot-symbol">S/</span>' + tR.toFixed(2);

    // Actualizar previsualización del contratante
    cot_actualizarContratante();

    requestAnimationFrame(cot_ajustarEscala);
}

function cot_actualizarContratante() {
    const input = document.getElementById("cot_nombreContratante");
    const box = document.getElementById("cot_nombre-contratante-box");
    const display = document.getElementById("cot_prev-contratante");
    if (!input || !box || !display) return;

    const val = input.value.trim();
    if (val) {
        display.textContent = val;
        box.style.display = "block";
    } else {
        box.style.display = "none";
    }
}

async function cot_exportarCotizacion(conDescuento) {
    const card = document.getElementById("cot_cotizacion-final");
    const bDesc = document.getElementById("cot_bloque-descuento");
    const bReg = document.getElementById("cot_bloque-regular");

    const originalState = { bDesc: bDesc.className, bReg: bReg.className };
    const originalItems = Array.from(card.querySelectorAll('.cot-lista-item')).map(item => item.innerHTML);

    if (!conDescuento) {
        bDesc.classList.add("hidden");
        bReg.classList.remove("hidden");
        card.querySelectorAll(".cot-lista-item").forEach(item => {
            const reg = item.querySelector(".cot-lista-reg-through");
            const prom = item.querySelector(".cot-lista-promo");
            if (reg && prom) {
                reg.classList.replace("cot-lista-reg-through", "cot-lista-reg-only");
                reg.classList.remove("block");
                prom.classList.add("hidden");
            }
        });
    }

    // Inyectar fuentes embedidas en Base64 dentro del card
    let injectedStyle = null;
    try {
        const fontCSS = await cot_cargarFuentesBase64();
        if (fontCSS) {
            injectedStyle = document.createElement('style');
            injectedStyle.id = '__font_embed__';
            injectedStyle.textContent = fontCSS;
            card.prepend(injectedStyle);
        }
    } catch (e) { console.warn('Font embed error:', e); }

    // Dar tiempo al browser para aplicar las fuentes embedidas
    await new Promise(r => setTimeout(r, 300));

    try {
        if (typeof htmlToImage === "undefined") {
            alert("La librería de exportación no está cargada aún.");
            return;
        }
        const dataUrl = await htmlToImage.toJpeg(card, {
            quality: 0.95,
            pixelRatio: 2,
            width: 450,
            backgroundColor: "#ffffff",
            skipFonts: false,
            style: {
                transform: 'scale(1)',
                transformOrigin: 'top left'
            }
        });
        const link = document.createElement("a");
        link.download = `Cotizacion_Auna_${conDescuento ? 'Promo' : 'Regular'}.jpg`;
        link.href = dataUrl;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    } catch (err) {
        console.error(err);
        alert("Error al generar la imagen: " + err.message);
    } finally {
        // Limpiar style embedido
        if (injectedStyle) injectedStyle.remove();
        bDesc.className = originalState.bDesc;
        bReg.className = originalState.bReg;
        card.querySelectorAll(".cot-lista-item").forEach((item, idx) => {
            item.innerHTML = originalItems[idx];
        });
    }
}

document.addEventListener("click", (e) => {
    const menu = document.getElementById("cot_menuModo");
    if (!menu) return;
    if (menu.classList.contains("hidden")) return;
    const trigger = document.querySelector(".cot-modo-btn");
    const clickDentroMenu = menu.contains(e.target);
    const clickDentroTrigger = trigger && trigger.contains(e.target);
    if (!clickDentroMenu && !clickDentroTrigger) {
        menu.classList.add("hidden");
        const chevron = document.getElementById("cot_chevronModo");
        if (chevron) chevron.style.transform = "";
    }
});


/* ══════════════════════════════════════════════
   WHATSAPP MODAL (Supabase)
══════════════════════════════════════════════ */
let _waMensajeBase = "";
let _waMensajeAnterior = "";

async function abrirWaModal(lead) {
    document.getElementById("wa-lead-info").textContent = `${lead.nombre} · ${lead.producto} · +51 ${lead.telefono}`;

    const overlay = document.getElementById("wa-modal-overlay");
    overlay.style.display = "flex";
    overlay.offsetHeight;
    overlay.classList.add("active");
    document.body.style.overflow = "hidden";

    const previewBox = document.getElementById("wa-preview-text");
    previewBox.innerHTML = `<div class="wa-loading">
    <span class="spinner" style="border-color:rgba(7,94,84,0.2);border-top-color:#075e54;width:20px;height:20px"></span>
    <span style="color:#075e54;font-size:0.85rem;font-weight:600">Cargando mensaje...</span>
  </div>`;

    const btnEditar = document.querySelector(".wa-btn-editar");
    if (btnEditar) btnEditar.style.visibility = "hidden";

    const usuario = leerSesion()?.usuario || "";
    try {
        const { data: dbUser } = await supabaseClient.from('usuarios').select('mensaje_whatsapp').eq('usuario', usuario).single();
        _waMensajeBase = dbUser?.mensaje_whatsapp || "";
    } catch {
        _waMensajeBase = "";
    }

    try {
        const { data: prodData } = await supabaseClient
            .from('detalles_producto')
            .select('detalle')
            .eq('producto', lead.producto)
            .single();
        window._ultimoLead.detalle_producto = prodData?.detalle || "";
    } catch {
        window._ultimoLead.detalle_producto = "";
    }

    document.getElementById("wa-mensaje").value = _waMensajeBase;
    if (btnEditar) btnEditar.style.visibility = "visible";
    mostrarModoPreview();
}

function mostrarModoPreview() {
    document.getElementById("wa-mode-preview").style.display = "block";
    document.getElementById("wa-mode-edit").style.display = "none";
    actualizarPreviewWa();
}

function abrirModoEdicion() {
    _waMensajeAnterior = document.getElementById("wa-mensaje").value;
    document.getElementById("wa-mode-preview").style.display = "none";
    document.getElementById("wa-mode-edit").style.display = "block";
    document.getElementById("wa-mensaje").oninput = actualizarPreviewWa;
    document.getElementById("wa-mensaje").focus();
}

function cancelarEdicion() {
    document.getElementById("wa-mensaje").value = _waMensajeAnterior;
    mostrarModoPreview();
}

function actualizarPreviewWa() {
    const lead = window._ultimoLead || {};
    const texto = (document.getElementById("wa-mensaje")?.value || "")
        .replace(/\{nombre\}/gi, lead.nombre || "")
        .replace(/\{producto\}/gi, lead.producto || "")
        .replace(/\{detalle_producto\}/gi, lead.detalle_producto || "");
    document.getElementById("wa-preview-text").textContent = texto || "—";
}

function insertarVariable(variable) {
    const ta = document.getElementById("wa-mensaje");
    const ini = ta.selectionStart;
    const fin = ta.selectionEnd;
    ta.value = ta.value.slice(0, ini) + variable + ta.value.slice(fin);
    ta.selectionStart = ta.selectionEnd = ini + variable.length;
    ta.focus();
    actualizarPreviewWa();
}

async function guardarMensajeWa() {
    const btn = document.getElementById("wa-btn-guardar");
    const text = btn.querySelector(".btn-text");
    const loader = btn.querySelector(".btn-loader");
    btn.disabled = true;
    text.style.display = "none";
    loader.style.display = "inline-flex";

    const usuario = leerSesion()?.usuario || "";
    const mensaje = document.getElementById("wa-mensaje").value;
    _waMensajeBase = mensaje;

    try {
        const { error } = await supabaseClient.from('usuarios').update({ mensaje_whatsapp: mensaje }).eq('usuario', usuario);
        if (error) throw error;
        mostrarModoPreview();
    } catch {
        alert("Error al guardar el mensaje. Intenta de nuevo.");
    } finally {
        btn.disabled = false;
        text.style.display = "inline";
        loader.style.display = "none";
    }
}

function enviarWhatsapp() {
    const lead = window._ultimoLead || {};
    const telefono = (lead.telefono || "").replace(/\D/g, "");
    const numero = "51" + telefono;

    const mensaje = (document.getElementById("wa-mensaje")?.value || "")
        .replace(/\{nombre\}/gi, lead.nombre || "")
        .replace(/\{producto\}/gi, lead.producto || "")
        .replace(/\{detalle_producto\}/gi, lead.detalle_producto || "");

    if (!telefono) { alert("No se encontró el número de teléfono del lead."); return; }
    window.open(`https://wa.me/${numero}?text=${encodeURIComponent(mensaje)}`, "_blank");
}

function closeWaModal(event) {
    if (event && event.target !== document.getElementById("wa-modal-overlay")) return;
    const overlay = document.getElementById("wa-modal-overlay");
    overlay.classList.remove("active");
    setTimeout(() => { overlay.style.display = "none"; document.body.style.overflow = ""; }, 250);
}


/* ══════════════════════════════════════════════
   PROYECCIÓN (Supabase - Optimizada)
══════════════════════════════════════════════ */
let proy_filasCount = 0;
let _proy_usuariosAdmin = [];

function proy_fechaHoyLima() {
    const now = new Date();
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Lima", day: "2-digit", month: "2-digit", year: "numeric" }).formatToParts(now);
    const get = t => parts.find(p => p.type === t)?.value ?? "";
    return `${get("day")}/${get("month")}/${get("year")}`;
}

function proy_parsearHora(str) {
    if (!str) return "";
    const m = str.trim().match(/^(\d{1,2})\s*(am|pm)$/i);
    if (!m) return str;
    let h = parseInt(m[1], 10);
    const ap = m[2].toLowerCase();
    if (ap === "pm" && h !== 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    return `${String(h).padStart(2, "0")}:00`;
}

function proy_renderFila(idx, data = {}) {
    const productos = ["Auna Classic", "Auna Premium", "Auna Senior", "Onco Pro", "Onco Plus"];
    const estados = ["Generado", "Por Vencer", "Pagado", "Pendiente"];
    const horas = ["1 am", "2 am", "3 am", "4 am", "5 am", "6 am", "7 am", "8 am", "9 am", "10 am", "11 am", "12 pm", "1 pm", "2 pm", "3 pm", "4 pm", "5 pm", "6 pm", "7 pm", "8 pm", "9 pm", "10 pm", "11 pm", "12 am"];
    const prodOpts = productos.map(p => `<option value="${p}" ${data.producto === p ? "selected" : ""}>${p}</option>`).join("");
    const estadOpts = estados.map(s => `<option value="${s}" ${data.estado === s ? "selected" : ""}>${s}</option>`).join("");
    const densOpts = [1, 2, 3, 4].map(n => `<option value="${n}" ${data.densidad == n ? "selected" : ""}>${n}</option>`).join("");
    const horaOpts = horas.map(h => `<option value="${h}" ${data.horaDisplay === h ? "selected" : ""}>${h}</option>`).join("");

    return `
  <div class="proy-fila" id="proy-fila-${idx}">
    <div class="proy-fila-header">
      <span class="proy-fila-num">Prospecto ${idx}</span>
      ${idx > 1 ? `<button type="button" class="proy-btn-remove" onclick="proy_eliminarFila(${idx})" title="Eliminar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>` : ""}
    </div>
    <div class="proy-fila-grid">
      <div class="field-group"><label class="field-label">Nombre</label><input type="text" id="proy-nombre-${idx}" value="${data.nombre || ""}" placeholder="Nombre del prospecto" class="proy-input"></div>
      <div class="field-group"><label class="field-label">Densidad</label><div class="select-wrap"><select id="proy-densidad-${idx}" class="proy-select">${densOpts}</select><svg class="select-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg></div></div>
      <div class="field-group"><label class="field-label">Producto</label><div class="select-wrap"><select id="proy-producto-${idx}" class="proy-select">${prodOpts}</select><svg class="select-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg></div></div>
      <div class="field-group"><label class="field-label">Estado</label><div class="select-wrap"><select id="proy-estado-${idx}" class="proy-select">${estadOpts}</select><svg class="select-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg></div></div>
      <div class="field-group"><label class="field-label">Hora</label><div class="select-wrap"><select id="proy-hora-${idx}" class="proy-select">${horaOpts}</select><svg class="select-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg></div></div>
    </div>
  </div>`;
}

function proy_agregarFila(data = {}) {
    proy_filasCount++;
    const wrap = document.getElementById("proy-filas-wrap");
    const div = document.createElement("div");
    div.innerHTML = proy_renderFila(proy_filasCount, data);
    wrap.appendChild(div.firstElementChild);
}

function proy_eliminarFila(idx) {
    const el = document.getElementById("proy-fila-" + idx);
    if (el) el.remove();
}

function proy_leerFilas() {
    const filas = [];
    let hasErrors = false;

    document.querySelectorAll(".proy-fila").forEach(fila => {
        const id = fila.id.replace("proy-fila-", "");
        const nombreInput = document.getElementById("proy-nombre-" + id);
        const nombreVal = nombreInput?.value.trim() || "";
        const horaDisplay = document.getElementById("proy-hora-" + id)?.value || "1 pm";

        if (!nombreVal) {
            if (nombreInput) nombreInput.classList.add("invalid");
            hasErrors = true;
        } else {
            if (nombreInput) nombreInput.classList.remove("invalid");
            filas.push({
                usuario: String(leerSesion()?.usuario || ""),
                dia: String(proy_fechaHoyLima()),
                nombre: String(nombreVal),
                densidad: String(document.getElementById("proy-densidad-" + id)?.value || "1"),
                producto: String(document.getElementById("proy-producto-" + id)?.value || ""),
                estado: String(document.getElementById("proy-estado-" + id)?.value || ""),
                hora: String(horaDisplay),
            });
        }
    });

    if (hasErrors) return null;
    return filas;
}

async function proy_init() {
    const rol = leerSesion()?.rol;
    const esAdmin = rol === "Administrador";

    document.getElementById("proy-loading").style.display = "block";
    document.getElementById("proy-preview-view").style.display = "none";
    document.getElementById("proy-asesor-view").style.display = "none";
    document.getElementById("proy-admin-view").style.display = "none";
    document.getElementById("proy-header-asesor").style.display = esAdmin ? "none" : "flex";
    document.getElementById("proy-header-admin").style.display = esAdmin ? "flex" : "none";

    const hoy = proy_fechaHoyLima();
    document.getElementById("proy-fecha-sub").textContent = `Proyección para hoy — ${hoy}`;
    document.getElementById("proy-admin-fecha").textContent = `Proyecciones del día — ${hoy}`;

    try {
        const { data: proyecciones } = await supabaseClient.from('proyeccion').select('*').eq('dia', hoy);

        document.getElementById("proy-loading").style.display = "none";

        if (esAdmin) {
            const { data: todosUsuarios } = await supabaseClient.from('usuarios').select('*').limit(10000);
            _proy_usuariosAdmin = todosUsuarios || [];
            document.getElementById("proy-admin-view").style.display = "block";
            proy_renderAdmin(proyecciones || [], _proy_usuariosAdmin);
        } else {
            const usuario = leerSesion()?.usuario || "";
            const misFilas = (proyecciones || []).filter(f => (f.usuario || "").toLowerCase() === usuario.toLowerCase());

            if (misFilas.length > 0) {
                document.getElementById("proy-preview-view").style.display = "block";
                proy_renderPreview(misFilas);
                proy_filasCount = 0;
                document.getElementById("proy-filas-wrap").innerHTML = "";
                misFilas.forEach(f => proy_agregarFila({ ...f, horaDisplay: f.hora }));
            } else {
                document.getElementById("proy-asesor-view").style.display = "block";
                proy_filasCount = 0;
                document.getElementById("proy-filas-wrap").innerHTML = "";
                proy_agregarFila();
            }
        }
    } catch (error) {
        console.error("Detalle DB (Cargar Proyección):", error);
        document.getElementById("proy-loading").style.display = "none";
        if (!esAdmin) {
            document.getElementById("proy-asesor-view").style.display = "block";
            proy_filasCount = 0;
            document.getElementById("proy-filas-wrap").innerHTML = "";
            proy_agregarFila();
        }
    }
}

function proy_renderPreview(filas) {
    const total = filas.reduce((s, f) => s + (parseInt(f.densidad) || 0), 0);
    let html = `
    <div class="proy-preview-kpi">
      <div class="proy-preview-kpi-num">${total}</div>
      <div class="proy-preview-kpi-label">unidad${total !== 1 ? "es" : ""} proyectada${total !== 1 ? "s" : ""} hoy</div>
    </div>
    <div style="overflow-x:auto">
    <table class="data-table">
      <thead><tr><th>Nombre</th><th>Densidad</th><th>Producto</th><th>Estado</th><th>Hora</th></tr></thead>
      <tbody>
        ${filas.map(f => `<tr>
          <td style="font-weight:600">${f.nombre || "—"}</td>
          <td style="text-align:center">${f.densidad || "—"}</td>
          <td><span class="badge-product ${getBadgeClass(f.producto)}">${f.producto || "—"}</span></td>
          <td>${proy_estadoBadge(f.estado)}</td>
          <td style="color:var(--slate-500);font-size:0.82rem">${f.hora || "—"}</td>
        </tr>`).join("")}
      </tbody>
    </table>
    </div>`;
    document.getElementById("proy-preview-tabla").innerHTML = html;
}

function proy_mostrarEditor() {
    document.getElementById("proy-preview-view").style.display = "none";
    document.getElementById("proy-asesor-view").style.display = "block";
}

let _proy_datosAdmin = [];

function proy_renderAdmin(data, todosUsuarios = []) {
    _proy_datosAdmin = data;
    const wrap = document.getElementById("proy-admin-tabla");
    const totalUnidades = data.reduce((sum, f) => sum + (parseInt(f.densidad) || 0), 0);
    document.getElementById("proy-total-unidades").textContent = totalUnidades;

    const mapaAgentes = {};
    todosUsuarios.forEach(u => {
        mapaAgentes[u.usuario] = u.agente || u.usuario;
    });

    const porAsesor = {};
    data.forEach(f => {
        const key = f.usuario || "—";
        if (!porAsesor[key]) porAsesor[key] = [];
        porAsesor[key].push(f);
    });

    const asesoresRegistrados = todosUsuarios
        .filter(u => (u.rol || "").toLowerCase() !== "administrador")
        .map(u => u.usuario);

    const todosAsesores = [...new Set([...Object.keys(porAsesor), ...asesoresRegistrados])];

    let html = "";
    const enviaron = todosAsesores.filter(a => porAsesor[a]);
    const noEnviaron = todosAsesores.filter(a => !porAsesor[a] && a !== "—");

    if (enviaron.length === 0 && noEnviaron.length === 0) {
        wrap.innerHTML = `<div class="empty-state" style="padding:3rem"><p>No hay proyecciones registradas para hoy.</p></div>`;
        return;
    }

    enviaron.forEach(usuarioId => {
        const filas = porAsesor[usuarioId];
        const totalAsesor = filas.reduce((s, f) => s + (parseInt(f.densidad) || 0), 0);
        const nombreAgente = mapaAgentes[usuarioId] || usuarioId;

        const mix = {};
        filas.forEach(f => {
            const p = f.producto || "Otros";
            mix[p] = (mix[p] || 0) + (parseInt(f.densidad) || 1);
        });

        const getMiniKpiHtml = () => {
            const mapColors = {
                "Auna Classic": "blue",
                "Auna Premium": "purple",
                "Auna Senior": "green",
                "Onco Pro": "orange",
                "Onco Plus": "red"
            };
            return Object.entries(mix).map(([prod, cant]) => {
                const color = mapColors[prod] || "slate";
                const inicial = prod.split(" ").pop();
                return `<span class="proy-mini-kpi ${color}">${inicial}: ${cant}</span>`;
            }).join("");
        };

        html += `
        <div class="proy-admin-asesor" id="proy-asesor-card-${usuarioId}">
          <div class="proy-admin-asesor-header" onclick="proy_toggleAsesor('${usuarioId}')">
            <div class="proy-admin-avatar">${nombreAgente.charAt(0).toUpperCase()}</div>
            <div style="flex:1">
              <div class="proy-admin-nombre">${nombreAgente}</div>
              <div class="proy-mini-kpis">${getMiniKpiHtml()}</div>
            </div>
            <div style="text-align:right">
              <div class="proy-admin-badge enviado">✓ ${totalAsesor} un.</div>
            </div>
            <svg class="proy-toggle-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
          </div>
          <div class="proy-admin-content">
            <div style="overflow-x:auto; padding: 0.5rem 1rem 1.25rem;">
              <table class="data-table">
                <thead><tr><th>Nombre</th><th>Un.</th><th>Producto</th><th>Estado</th><th>Hora</th></tr></thead>
                <tbody>
                  ${filas.map(f => `<tr>
                    <td style="font-weight:600">${f.nombre || "—"}</td>
                    <td style="text-align:center">${f.densidad || "—"}</td>
                    <td><span class="badge-product ${getBadgeClass(f.producto)}">${f.producto || "—"}</span></td>
                    <td>${proy_estadoBadge(f.estado)}</td>
                    <td style="white-space:nowrap;color:var(--slate-500);font-size:0.82rem">${f.hora || "—"}</td>
                  </tr>`).join("")}
                </tbody>
              </table>
            </div>
          </div>
        </div>`;
    });

    if (noEnviaron.length > 0) {
        html += `<div class="proy-pendientes-wrap">
      <p class="proy-pendientes-title">⏳ Sin proyección hoy</p>
      <div class="proy-pendientes-list">
        ${noEnviaron.map(usuarioId => {
            const nombreAgente = mapaAgentes[usuarioId] || usuarioId;
            return `
          <div class="proy-pendiente-item">
            <div class="proy-admin-avatar" style="background:var(--slate-200);color:var(--slate-500)">${nombreAgente.charAt(0).toUpperCase()}</div>
            <span class="proy-admin-nombre" style="color:var(--slate-500)">${nombreAgente}</span>
            <span class="proy-admin-badge pendiente">Sin enviar</span>
          </div>`
        }).join("")}
      </div>
    </div>`;
    }
    wrap.innerHTML = html;
}

function proy_estadoBadge(estado) {
    const cfg = {
        "Generado": { bg: "#dbeafe", color: "#1d4ed8" },
        "Por Vencer": { bg: "#fef9c3", color: "#92400e" },
        "Pagado": { bg: "#dcfce7", color: "#166534" },
        "Pendiente": { bg: "#fee2e2", color: "#b91c1c" },
    };
    const c = cfg[estado];
    if (!c) return estado || "—";
    return `<span style="display:inline-block;padding:3px 10px;border-radius:100px;font-size:0.75rem;font-weight:700;background:${c.bg};color:${c.color}">${estado}</span>`;
}

async function proy_guardar() {
    const btn = document.getElementById("proy-btn-save");
    const text = btn.querySelector(".btn-text");
    const loader = document.querySelector(".btn-loader");

    const filas = proy_leerFilas();

    if (filas === null) {
        alert("Por favor, completa el nombre en todos los prospectos de tu proyección.");
        return;
    }
    if (filas.length === 0) {
        alert("Agrega al menos un prospecto antes de guardar.");
        return;
    }

    btn.disabled = true; text.style.display = "none"; loader.style.display = "flex";

    const usuario = leerSesion()?.usuario || "";
    const fecha = proy_fechaHoyLima();

    try {
        const { data: oldData } = await supabaseClient.from('proyeccion')
            .select('*')
            .eq('usuario', usuario)
            .eq('dia', fecha);

        const { error: delErr } = await supabaseClient.from('proyeccion')
            .delete()
            .eq('usuario', usuario)
            .eq('dia', fecha);

        if (delErr) throw delErr;

        const { error: insErr } = await supabaseClient.from('proyeccion').insert(filas);

        if (insErr) {
            if (oldData && oldData.length > 0) {
                const rollbackData = oldData.map(r => { const { id, ...rest } = r; return rest; });
                await supabaseClient.from('proyeccion').insert(rollbackData);
            }
            throw insErr;
        }

        const toast = document.getElementById("toast");
        if (toast) {
            toast.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg> ¡Proyección guardada!`;
            toast.style.display = "flex";
            setTimeout(() => { toast.style.display = "none"; }, 3000);
        }

        document.getElementById("proy-asesor-view").style.display = "none";
        document.getElementById("proy-preview-view").style.display = "block";
        proy_renderPreview(filas);

    } catch (error) {
        console.error("Detalle DB (Guardar Proyección):", error);
        alert("Error al guardar la proyección. Tu trabajo anterior está seguro. Revisa tu conexión e intenta de nuevo.");
    } finally {
        btn.disabled = false; text.style.display = "inline"; loader.style.display = "none";
    }
}

function proy_descargarExcel() {
    const data = _proy_datosAdmin;
    if (!data || data.length === 0) {
        alert("No hay proyecciones del día para descargar.");
        return;
    }

    const hoy = proy_fechaHoyLima();
    const mapaAgentes = {};
    _proy_usuariosAdmin.forEach(u => {
        mapaAgentes[u.usuario] = u.agente || u.usuario;
    });

    try {
        const filas = data.map(f => ({
            "Asesor": String(mapaAgentes[f.usuario] || f.usuario || ""),
            "Usuario": String(f.usuario || ""),
            "Nombre": String(f.nombre || ""),
            "Densidad": parseInt(f.densidad) || 0,
            "Producto": String(f.producto || ""),
            "Estado": String(f.estado || ""),
            "Hora": String(f.hora || ""),
        }));

        const ws = XLSX.utils.json_to_sheet(filas, {
            header: ["Asesor", "Usuario", "Nombre", "Densidad", "Producto", "Estado", "Hora"]
        });
        ws["!cols"] = [{ wch: 18 }, { wch: 14 }, { wch: 22 }, { wch: 10 }, { wch: 20 }, { wch: 14 }, { wch: 10 }];

        const wb = XLSX.utils.book_new();
        const sheetName = `Proyeccion ${hoy}`.replace(/\//g, "-").slice(0, 31);
        XLSX.utils.book_append_sheet(wb, ws, sheetName);
        XLSX.writeFile(wb, `Proyeccion_${hoy.replace(/\//g, "-")}.xlsx`);

    } catch (err) {
        alert("Error al generar el archivo. Intenta de nuevo.");
    }
}

function proy_toggleAsesor(usuarioId) {
    const card = document.getElementById(`proy-asesor-card-${usuarioId}`);
    if (!card) return;
    card.classList.toggle("active");
}

/* ══════════════════════════════════════════════
   GESTIÓN DE EQUIPO (ADMINISTRADORES)
══════════════════════════════════════════════ */
async function abrirModalEquipo() {
    const sesion = leerSesion();
    if (sesion?.rol !== "Administrador") {
        alert("Esta función es exclusiva para Supervisores/Administradores.");
        return;
    }

    const msgContainer = document.getElementById("team-msg-container");
    if (msgContainer) msgContainer.style.display = "none";

    document.getElementById("new-user-nombre").value = "";
    document.getElementById("new-user-apellido").value = "";
    document.getElementById("new-user-email").value = "";
    document.getElementById("preview-user").textContent = "...";
    document.getElementById("preview-pass").textContent = "...";

    const overlay = document.getElementById("team-modal-overlay");
    overlay.style.display = "flex";
    overlay.offsetHeight;
    overlay.classList.add("active");
    document.body.style.overflow = "hidden";

    switchTeamTab('crear');
    cargarListaEquipo();
}

function closeTeamModal(e) {
    if (e && e.target !== document.getElementById("team-modal-overlay")) return;
    const overlay = document.getElementById("team-modal-overlay");
    overlay.classList.remove("active");
    setTimeout(() => {
        overlay.style.display = "none";
        document.body.style.overflow = "";
    }, 250);
}

function showTeamMessage(msg, type = 'success', copyText = null) {
    const container = document.getElementById("team-msg-container");
    const label = document.getElementById("team-msg");
    const icon = document.getElementById("team-msg-icon");

    container.className = `team-message-bar ${type}`;
    label.innerHTML = msg;

    if (type === 'success') {
        icon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width:18px; height:18px;"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`;

        // Si hay texto para copiar, agregamos el botón
        if (copyText) {
            const copyBtn = document.createElement("button");
            copyBtn.className = "team-copy-btn";
            copyBtn.innerHTML = `
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                </svg>
                Copiar accesos
            `;
            copyBtn.onclick = () => copiarAccesos(copyText, copyBtn);
            container.appendChild(copyBtn);
        }
    } else {
        icon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width:18px; height:18px;"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`;
    }

    container.style.display = "flex";
}

function copiarAccesos(texto, btn) {
    navigator.clipboard.writeText(texto).then(() => {
        const originalHTML = btn.innerHTML;
        btn.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="color:var(--emerald-600)">
                <polyline points="20 6 9 17 4 12"/>
            </svg>
            ¡Copiado!
        `;
        btn.style.borderColor = "var(--emerald-500)";
        btn.style.color = "var(--emerald-600)";

        setTimeout(() => {
            btn.innerHTML = originalHTML;
            btn.style.borderColor = "";
            btn.style.color = "";
        }, 2000);
    });
}

function switchTeamTab(tab) {
    const isCrear = tab === 'crear';
    const sectionCrear = document.getElementById("team-crear-section");
    const sectionEliminar = document.getElementById("team-eliminar-section");
    const tabCrear = document.getElementById("tab-team-crear");
    const tabEliminar = document.getElementById("tab-team-eliminar");
    const subtitle = document.getElementById("team-subtitle");

    sectionCrear.style.display = isCrear ? "block" : "none";
    sectionEliminar.style.display = isCrear ? "none" : "block";

    tabCrear.classList.toggle("active", isCrear);
    tabEliminar.classList.toggle("active", !isCrear);

    subtitle.textContent = isCrear ? "Registra un nuevo integrante" : "Administra los accesos de tu grupo";

    const msgContainer = document.getElementById("team-msg-container");
    if (msgContainer) msgContainer.style.display = "none";
}

function actualizarPreviews() {
    const nombre = document.getElementById("new-user-nombre").value.trim();
    const apellido = document.getElementById("new-user-apellido").value.trim();

    if (nombre && apellido) {
        const userGen = (nombre + apellido).toLowerCase().replace(/\s/g, "");
        const passGen = nombre.charAt(0).toUpperCase() + nombre.slice(1).toLowerCase() + "123.";
        document.getElementById("preview-user").textContent = userGen;
        document.getElementById("preview-pass").textContent = passGen;
    } else {
        document.getElementById("preview-user").textContent = "...";
        document.getElementById("preview-pass").textContent = "...";
    }
}

document.addEventListener('input', (e) => {
    if (e.target.id === 'new-user-nombre' || e.target.id === 'new-user-apellido') {
        actualizarPreviews();
    }
});

async function cargarListaEquipo() {
    const contenedor = document.getElementById("team-members-list");
    contenedor.innerHTML = `
        <div style="display:flex; flex-direction:column; align-items:center; gap:10px; padding:20px; color:var(--slate-400);">
            <div class="spinner-mini" style="border-top-color:var(--blue-500); border-width:2px; width:24px; height:24px;"></div>
            <span style="font-size:0.8rem; font-weight:600;">Sincronizando equipo...</span>
        </div>`;

    try {
        const { data, error } = await supabaseClient
            .from('usuarios')
            .select('usuario, rol')
            .neq('rol', 'Administrador')
            .order('usuario', { ascending: true });

        if (error) throw error;

        if (data.length === 0) {
            contenedor.innerHTML = `
                <div style="text-align:center; padding:30px 10px; color:var(--slate-400);">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width:40px; height:40px; margin-bottom:10px; opacity:0.5;">
                        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
                    </svg>
                    <p style="font-size:0.85rem; font-weight:500;">No hay asesores en tu equipo todavía.</p>
                </div>`;
            return;
        }

        let html = "";
        data.forEach(user => {
            const inicial = user.usuario.charAt(0).toUpperCase();
            html += `
            <div class="team-member-card">
                <div class="member-avatar">${inicial}</div>
                <div class="member-info">
                    <h4>${user.usuario}</h4>
                    <span>Asesor de Equipo</span>
                </div>
                <button onclick="ejecutarEliminarAsesor('${user.usuario}')" class="member-delete-btn" title="Eliminar Acceso">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M3 6h18m-2 0v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6h14zM8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                    </svg>
                </button>
            </div>`;
        });
        contenedor.innerHTML = html;
    } catch (err) {
        contenedor.innerHTML = `<p style="color:var(--red-600); text-align:center; padding:20px; font-size:0.8rem;">⚠️ Error al cargar el equipo.</p>`;
    }
}

async function ejecutarCrearAsesor() {
    const nInput = document.getElementById("new-user-nombre");
    const aInput = document.getElementById("new-user-apellido");
    const eInput = document.getElementById("new-user-email");

    const nombre = nInput.value.trim();
    const apellido = aInput.value.trim();
    const emailReal = eInput.value.trim();

    if (!nombre || !apellido || !emailReal) {
        return showTeamMessage("❌ Completa todos los campos.", "error");
    }

    const usuarioAuto = (nombre + apellido).toLowerCase().replace(/\s/g, "");
    const passAuto = nombre.charAt(0).toUpperCase() + nombre.slice(1).toLowerCase() + "123.";

    // 1. EL CAMBIO: Construimos el mensaje dinámico usando las variables ingresadas
    const mensajeWaDefault = `Hola {nombre}! Soy *${nombre} ${apellido}* 👋🏼, consultor de *AUNA SALUD* 🏥\n\nAcá te comparto la información del plan *{producto}*:\n\n\n{detalle_producto}`;

    const btn = document.getElementById("btn-crear-asesor");
    btn.disabled = true;
    btn.querySelector(".btn-text").style.display = "none";
    btn.querySelector(".btn-loader").style.display = "flex";

    try {
        const { data: { user: adminAuth }, error: authErr } = await supabaseClient.auth.getUser();
        if (authErr || !adminAuth) throw new Error("No se pudo validar tu sesión activa.");

        const { data: adminData, error: errAdmin } = await supabaseClient
            .from('usuarios')
            .select('equipo')
            .eq('id', adminAuth.id)
            .single();

        if (errAdmin) throw new Error("No pudimos verificar tu equipo en la base de datos.");
        const miEquipo = adminData.equipo || 'Sin Equipo';

        const tempClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
            auth: { persistSession: false }
        });

        const { error } = await tempClient.auth.signUp({
            email: emailReal,
            password: passAuto,
            options: {
                data: {
                    nombre: nombre,
                    apellido: apellido,
                    username: usuarioAuto,
                    equipo: miEquipo,
                    rol: 'Asesor',
                    // 2. EL CAMBIO: Enviamos el mensaje en la metadata de Supabase
                    mensaje_whatsapp: mensajeWaDefault
                }
            }
        });

        if (error) throw error;

        // Texto plano para copiar al portapapeles
        const textoCopiar = `Hola *${nombre}!* Bienvenid@ a la familia *${miEquipo}*. Estamos listos para romperla juntos! 🔥

Tus accesos están listos:

📍 *Plataforma:* https://auna-oncosalud.github.io/panel
👤 *Usuario:* ${usuarioAuto}
🔑 *Clave:* ${passAuto}

Entra, dale un vistazo y prepárate para el éxito. *¡Bienvenido@ al equipo ganador!*🏆🥇`;

        showTeamMessage(`✅ ¡Asesor creado en ${miEquipo}!<br><small>Usuario: <b>${usuarioAuto}</b><br>Clave: <b>${passAuto}</b></small>`, "success", textoCopiar);

        nInput.value = "";
        aInput.value = "";
        eInput.value = "";
        actualizarPreviews();
        cargarListaEquipo();

    } catch (err) {
        let errorMsg = err.message;
        if (errorMsg.includes("already")) errorMsg = "El correo o usuario ya existen.";
        showTeamMessage(`Error: ${errorMsg}`, "error");
    } finally {
        btn.disabled = false;
        btn.querySelector(".btn-text").style.display = "flex";
        btn.querySelector(".btn-loader").style.display = "none";
    }
}

async function ejecutarEliminarAsesor(nombreAsesor) {
    if (!confirm(`¿Estás seguro de eliminar a "${nombreAsesor.toUpperCase()}"? Se revocará su acceso de forma permanente.`)) return;

    showTeamMessage("Procesando eliminación...", "success");

    try {
        const { error } = await supabaseClient.rpc('eliminar_asesor_equipo', { p_nombre: nombreAsesor.toLowerCase() });
        if (error) throw error;

        showTeamMessage(`El asesor "${nombreAsesor}" ha sido eliminado.`, "success");
        cargarListaEquipo();
    } catch (err) {
        showTeamMessage(`No se pudo eliminar: ${err.message}`, "error");
    }
}

/* ═════════════════════════════════════════════════════════════════════════════
   CARTERA DE CLIENTES
═════════════════════════════════════════════════════════════════════════════ */
let allCartera = [];
let carteraFiltroEstado = 'todos';
let carteraFiltroPlan = 'todos';
let carteraFiltroAsesor = 'todos';
let carteraEditandoId = null;

async function cartera_init() {
    if (allCartera.length === 0) {
        await cartera_cargar();
    } else {
        cartera_aplicarFiltros();
    }
}

async function cartera_cargar() {
    const container = document.getElementById("cartera-tabla-container");
    container.innerHTML = `
        <div class="empty-state cartera-empty-state">
            <div class="loading-dots"><span></span><span></span><span></span></div>
            <p>Cargando cartera...</p>
        </div>`;

    try {
        const { data, error } = await supabaseClient
            .from('cartera')
            .select('*')
            .order('fecha_afiliacion', { ascending: false });

        if (error) throw error;
        allCartera = data || [];

        document.getElementById("cartera-sub-count").textContent = `${allCartera.length} cliente${allCartera.length !== 1 ? 's' : ''}`;

        const rol = leerSesion()?.rol;
        if (rol === "Administrador") {
            document.getElementById("wrap-cartera-filtro-asesor").style.display = "flex";
            cartera_poblarSelectAsesores();
        }

        cartera_aplicarFiltros();
    } catch (e) {
        console.error("Error loading cartera:", e);
        container.innerHTML = `<p style="color:red;text-align:center;padding:20px;">Error al cargar datos.</p>`;
    }
}

function cartera_poblarSelectAsesores() {
    const sel = document.getElementById("cartera-filtro-asesor");
    const usuarios = [...new Set(allCartera.map(c => c.usuario).filter(Boolean))].sort();

    let html = `<option value="todos">Todos los asesores</option>`;
    usuarios.forEach(u => {
        html += `<option value="${u}">${u}</option>`;
    });
    sel.innerHTML = html;

    if (usuarios.includes(carteraFiltroAsesor)) {
        sel.value = carteraFiltroAsesor;
    } else {
        carteraFiltroAsesor = 'todos';
    }
}

function cartera_setFiltroEstado(estado) {
    document.querySelectorAll(".qf-btn").forEach(b => b.classList.remove("active"));
    document.getElementById(`cartera-qf-${estado}`).classList.add("active");
    carteraFiltroEstado = estado;
    cartera_aplicarFiltros(true);
}

function cartera_aplicarFiltros(resetPage = true) {
    if (resetPage) {
        carteraPaginaActual = 1;
    }
    const q = document.getElementById("cartera-search").value.toLowerCase();
    const plan = document.getElementById("cartera-filtro-plan").value;
    const asesor = document.getElementById("cartera-filtro-asesor")?.value || 'todos';
    carteraFiltroAsesor = asesor;

    const isMobile = window.innerWidth <= 640;

    let filtered = allCartera.filter(c => {
        const txt = `${c.contratante} ${c.dni} ${c.celular}`.toLowerCase();
        if (q && !txt.includes(q)) return false;
        if (plan !== 'todos' && c.plan_salud !== plan) return false;
        if (asesor !== 'todos' && c.usuario !== asesor) return false;

        if (carteraFiltroEstado === 'aldia') return !tieneMoroso(c);
        if (carteraFiltroEstado === 'morosos') return tieneMoroso(c);
        if (carteraFiltroEstado === 'desafiliados') return tieneDesafiliado(c);
        return true;
    });

    cartera_renderTabla(filtered, isMobile);
}

function tieneMoroso(c) {
    for (let i = 1; i <= 12; i++) if (c[`m${i}`] === 'Moroso') return true;
    return false;
}
function tieneDesafiliado(c) {
    for (let i = 1; i <= 12; i++) if (c[`m${i}`] === 'Desafiliado') return true;
    return false;
}

function cartera_renderTabla(data, isMobile) {
    const container = document.getElementById("cartera-tabla-container");
    if (data.length === 0) {
        container.innerHTML = `<div class="empty-state cartera-empty-state"><p>No se encontraron clientes.</p></div>`;
        return;
    }

    const totalItems = data.length;
    const totalPaginas = Math.ceil(totalItems / 15);

    if (carteraPaginaActual > totalPaginas) carteraPaginaActual = totalPaginas;
    if (carteraPaginaActual < 1) carteraPaginaActual = 1;

    const dataPaginada = data.slice((carteraPaginaActual - 1) * 15, carteraPaginaActual * 15);

    const miUsuario = leerSesion()?.usuario;
    const rol = leerSesion()?.rol;

    if (isMobile) {
        let html = ``;
        dataPaginada.forEach(c => {
            const hasMoroso = tieneMoroso(c);
            const esMiRegistro = c.usuario === miUsuario;
            const cuotaActiva = cartera_obtenerCuotaActiva(c.fecha_afiliacion);

            let chipsHtml = ``;
            for (let i = 1; i <= 12; i++) {
                const esActiva = (i === cuotaActiva);
                chipsHtml += cartera_estadoChipHtml(`M${i}`, c[`m${i}`] || 'Pendiente', esActiva);
            }

            html += `
            <div class="cartera-row-card ${hasMoroso ? 'has-moroso' : ''}" ${esMiRegistro ? `onclick="cartera_abrirModal('${c.id}')" style="cursor:pointer;" title="Click para editar"` : ''}>
                <div class="cartera-card-header">
                    <div>
                        <h4 class="cartera-card-title">${c.contratante}</h4>
                        <span class="cartera-card-plan">${c.plan_salud}</span>
                        ${rol === 'Administrador' ? `<span style="font-size:0.7rem; color:var(--slate-500); display:block; margin-top:2px;">Asesor: ${c.usuario}</span>` : ''}
                    </div>
                    <div style="display:flex; gap:8px;">
                        <button class="btn-whatsapp" onclick="event.stopPropagation(); cartera_abrirWhatsApp('${c.celular}')">
                            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/><path d="M11.5 2C6.253 2 2 6.253 2 11.5c0 1.87.518 3.618 1.414 5.106L2 22l5.565-1.396A9.455 9.455 0 0 0 11.5 21C16.747 21 21 16.747 21 11.5S16.747 2 11.5 2zm0 17.25a7.725 7.725 0 0 1-3.947-1.082l-.283-.168-2.933.735.784-2.862-.184-.293A7.713 7.713 0 0 1 3.75 11.5C3.75 7.22 7.22 3.75 11.5 3.75S19.25 7.22 19.25 11.5 15.78 19.25 11.5 19.25z"/></svg>
                        </button>
                    </div>
                </div>
                <div style="font-size:0.8rem; color:var(--slate-600); margin-bottom:8px;">
                    Fecha: ${c.fecha_afiliacion} | DNI: ${c.dni} | Cel: ${c.celular} <br>
                    Mensualidad: <span class="cartera-card-monto">S/ ${c.mensualidad}</span> | Bono: <span class="cartera-card-monto">S/ ${c.bono || '0.00'}</span>
                </div>
                <div class="cartera-meses-scroll">
                    ${chipsHtml}
                </div>
            </div>`;
        });
        container.innerHTML = `<div style="padding:1rem;">${html}</div>`;
    } else {
        let theadHtml = `
            <tr>
                <th class="cartera-th">Fecha de afiliación</th>
                <th class="cartera-th">Contratante</th>
                <th class="cartera-th">DNI</th>
                <th class="cartera-th">Celular</th>
                ${rol === 'Administrador' ? '<th class="cartera-th">Asesor</th>' : ''}
                <th class="cartera-th">Plan</th>
                <th class="cartera-th">Mensualidad</th>
                <th class="cartera-th">Bono</th>
                <th class="cartera-th">Seguimiento de Pagos (M1-M12)</th>
            </tr>`;

        let tbodyHtml = ``;
        dataPaginada.forEach(c => {
            const esMiRegistro = c.usuario === miUsuario;
            const cuotaActiva = cartera_obtenerCuotaActiva(c.fecha_afiliacion);
            let chipsHtml = `<div class="meses-grid-table">`;
            for (let i = 1; i <= 12; i++) {
                const esActiva = (i === cuotaActiva);
                chipsHtml += cartera_estadoChipHtml(`M${i}`, c[`m${i}`] || 'Pendiente', esActiva);
            }
            chipsHtml += `</div>`;

            tbodyHtml += `
            <tr class="cartera-tr" ${esMiRegistro ? `onclick="cartera_abrirModal('${c.id}')" style="cursor:pointer;" title="Click para editar"` : ''}>
                <td class="cartera-td" style="white-space:nowrap;">${c.fecha_afiliacion}</td>
                <td class="cartera-td cartera-td-nombre">${c.contratante}</td>
                <td class="cartera-td">${c.dni}</td>
                <td class="cartera-td">
                    ${c.celular}
                    <button class="btn-whatsapp" onclick="event.stopPropagation(); cartera_abrirWhatsApp('${c.celular}')" title="Enviar WhatsApp">
                        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/><path d="M11.5 2C6.253 2 2 6.253 2 11.5c0 1.87.518 3.618 1.414 5.106L2 22l5.565-1.396A9.455 9.455 0 0 0 11.5 21C16.747 21 21 16.747 21 11.5S16.747 2 11.5 2zm0 17.25a7.725 7.725 0 0 1-3.947-1.082l-.283-.168-2.933.735.784-2.862-.184-.293A7.713 7.713 0 0 1 3.75 11.5C3.75 7.22 7.22 3.75 11.5 3.75S19.25 7.22 19.25 11.5 15.78 19.25 11.5 19.25z"/></svg>
                    </button>
                </td>
                ${rol === 'Administrador' ? `<td class="cartera-td">${c.usuario}</td>` : ''}
                <td class="cartera-td"><span class="cartera-td-plan">${c.plan_salud}</span></td>
                <td class="cartera-td cartera-td-mensualidad">S/ ${c.mensualidad}</td>
                <td class="cartera-td">S/ ${c.bono || '0.00'}</td>
                <td class="cartera-td" style="padding: 1rem 4px;">${chipsHtml}</td>
            </tr>`;
        });

        container.innerHTML = `
            <div class="cartera-table-wrap">
                <table class="cartera-table">
                    <thead>${theadHtml}</thead>
                    <tbody>${tbodyHtml}</tbody>
                </table>
            </div>`;
    }

    if (totalItems > 15) {
        let pagHtml = `<div class="pagination-container">`;
        for (let p = 1; p <= totalPaginas; p++) {
            pagHtml += `<button class="pagination-btn ${p === carteraPaginaActual ? 'active' : ''}" onclick="cartera_cambiarPagina(${p})">${p}</button>`;
        }
        pagHtml += `</div>`;
        container.insertAdjacentHTML('beforeend', pagHtml);
    }
}

function cartera_cambiarPagina(p) {
    carteraPaginaActual = p;
    cartera_aplicarFiltros(false);
}

function cartera_obtenerCuotaActiva(fechaAfiliacion) {
    if (!fechaAfiliacion) return 0;
    const parts = fechaAfiliacion.split('-');
    if (parts.length !== 3) return 0;
    const aYear = parseInt(parts[0], 10);
    const aMonth = parseInt(parts[1], 10) - 1;
    const aDay = parseInt(parts[2], 10);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (let i = 1; i <= 12; i++) {
        let startDate;
        if (i === 1) {
            startDate = new Date(aYear, aMonth, aDay + 1);
        } else {
            startDate = new Date(aYear, aMonth + i - 1, aDay + 1);
        }
        startDate.setHours(0, 0, 0, 0);

        const endDate = new Date(aYear, aMonth + i, aDay);
        endDate.setHours(0, 0, 0, 0);

        if (today >= startDate && today <= endDate) {
            return i;
        }
    }
    return 0;
}

function cartera_estadoChipHtml(label, estado, esActiva = false) {
    let cssClass = 'pendiente';
    if (estado === 'Pagado') cssClass = 'pagado';
    else if (estado === 'Moroso') cssClass = 'moroso';
    else if (estado === 'Desafiliado') cssClass = 'desafiliado';

    const activeClass = esActiva ? 'cuota-activa' : '';
    return `<span class="mes-chip ${cssClass} ${activeClass}" title="${label}: ${estado}">${estado.charAt(0)}</span>`;
}

function cartera_abrirModal(id = null) {
    carteraEditandoId = id;
    const form = document.getElementById("cartera-form");
    form.reset();

    document.getElementById("cartera-modal-title").textContent = id ? "Editar Cliente" : "Nuevo Cliente";

    let mesesHtml = ``;
    for (let i = 1; i <= 12; i++) {
        mesesHtml += `
        <div class="mes-select-group">
            <label>M${i} <span id="chip-prev-m${i}" class="mes-chip pendiente" style="font-size:0.6rem; padding:2px 4px; min-width:auto;">Pendiente</span></label>
            <select id="cartera-m${i}" onchange="cartera_actualizarChipSelect(${i}, this.value)">
                <option value="Pagado">Pagado</option>
                <option value="Pendiente" selected>Pendiente</option>
                <option value="Moroso">Moroso</option>
                <option value="Desafiliado">Desafiliado</option>
            </select>
        </div>`;
    }
    document.getElementById("cartera-meses-container").innerHTML = mesesHtml;

    const delWrap = document.getElementById("cartera-btn-eliminar-wrap");
    delWrap.innerHTML = "";

    if (id) {
        const c = allCartera.find(x => x.id === id);
        if (c) {
            document.getElementById("cartera-fecha").value = c.fecha_afiliacion;
            document.getElementById("cartera-grupo").value = c.grupo_familiar;
            document.getElementById("cartera-dni").value = c.dni;
            document.getElementById("cartera-celular").value = c.celular || '';
            document.getElementById("cartera-contratante").value = c.contratante;
            document.getElementById("cartera-plan").value = c.plan_salud;
            document.getElementById("cartera-afiliados").value = c.afiliados;
            document.getElementById("cartera-mensualidad").value = c.mensualidad;
            document.getElementById("cartera-bono").value = c.bono || '';
            document.getElementById("cartera-calidad").value = c.calidad;

            for (let i = 1; i <= 12; i++) {
                const val = c[`m${i}`] || 'Pendiente';
                document.getElementById(`cartera-m${i}`).value = val;
                cartera_actualizarChipSelect(i, val);
            }

            delWrap.innerHTML = `<button type="button" class="btn-cancel" style="background:#fee2e2; color:#dc2626; border-color:#fecaca;" onclick="cartera_eliminar('${id}')">Eliminar</button>`;
        }
    }

    const overlay = document.getElementById("cartera-modal-overlay");
    overlay.style.display = "flex";
    // Force reflow for transition
    overlay.offsetHeight;
    overlay.classList.add("active");
    document.body.style.overflow = "hidden";
}

function cartera_cerrarModal(event = null) {
    if (event && event.target !== event.currentTarget) return;
    const overlay = document.getElementById("cartera-modal-overlay");
    overlay.classList.remove("active");
    document.body.style.overflow = "";
    setTimeout(() => { overlay.style.display = "none"; }, 250);
}

function cartera_actualizarChipSelect(m, val) {
    const chip = document.getElementById(`chip-prev-m${m}`);
    if (chip) {
        chip.textContent = val;
        chip.className = 'mes-chip';
        if (val === 'Pagado') chip.classList.add('pagado');
        else if (val === 'Moroso') chip.classList.add('moroso');
        else if (val === 'Desafiliado') chip.classList.add('desafiliado');
        else chip.classList.add('pendiente');
    }

    // Si se selecciona "Desafiliado", todas las cuotas posteriores se marcan automáticamente como "Desafiliado"
    if (val === 'Desafiliado') {
        for (let i = m + 1; i <= 12; i++) {
            const nextSelect = document.getElementById(`cartera-m${i}`);
            if (nextSelect && nextSelect.value !== 'Desafiliado') {
                nextSelect.value = 'Desafiliado';
                cartera_actualizarChipSelect(i, 'Desafiliado');
            }
        }
    }
}

async function cartera_guardar() {
    const form = document.getElementById("cartera-form");
    if (!form.checkValidity()) {
        form.reportValidity();
        return;
    }

    const btn = document.getElementById("btn-guardar-cartera");
    btn.disabled = true;
    btn.querySelector(".btn-loader").style.display = "inline-flex";
    btn.querySelector(".btn-text").style.display = "none";

    try {
        const meses = [];
        for (let i = 1; i <= 12; i++) {
            meses.push(document.getElementById(`cartera-m${i}`).value);
        }

        // Si alguna cuota está como "Desafiliado", todas las cuotas siguientes también se marcan como "Desafiliado"
        const indexDesafiliado = meses.indexOf("Desafiliado");
        if (indexDesafiliado !== -1) {
            for (let i = indexDesafiliado + 1; i < 12; i++) {
                meses[i] = "Desafiliado";
            }
        }

        const datos = {
            fecha_afiliacion: document.getElementById("cartera-fecha").value,
            grupo_familiar: document.getElementById("cartera-grupo").value,
            dni: document.getElementById("cartera-dni").value,
            celular: document.getElementById("cartera-celular").value,
            contratante: document.getElementById("cartera-contratante").value,
            plan_salud: document.getElementById("cartera-plan").value,
            afiliados: parseInt(document.getElementById("cartera-afiliados").value),
            mensualidad: parseFloat(document.getElementById("cartera-mensualidad").value),
            bono: document.getElementById("cartera-bono").value ? parseFloat(document.getElementById("cartera-bono").value) : null,
            calidad: document.getElementById("cartera-calidad").value,
            m1: meses[0],
            m2: meses[1],
            m3: meses[2],
            m4: meses[3],
            m5: meses[4],
            m6: meses[5],
            m7: meses[6],
            m8: meses[7],
            m9: meses[8],
            m10: meses[9],
            m11: meses[10],
            m12: meses[11],
        };

        if (carteraEditandoId) {
            const { error } = await supabaseClient
                .from('cartera')
                .update(datos)
                .eq('id', carteraEditandoId);
            if (error) throw error;
        } else {
            datos.usuario = leerSesion()?.usuario;
            const { error } = await supabaseClient
                .from('cartera')
                .insert([datos]);
            if (error) throw error;
        }

        cartera_cerrarModal();

        const toast = document.getElementById("toast-edit");
        toast.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" /></svg> ¡Cliente guardado con éxito!`;
        toast.style.display = "flex";
        setTimeout(() => toast.style.display = "none", 3000);

        await cartera_cargar();
    } catch (e) {
        console.error("Error guardando cliente:", e);
        alert("Error al guardar: " + e.message);
    } finally {
        btn.disabled = false;
        btn.querySelector(".btn-loader").style.display = "none";
        btn.querySelector(".btn-text").style.display = "inline";
    }
}

async function cartera_eliminar(id) {
    if (!confirm("¿Estás seguro de eliminar este cliente? Esta acción no se puede deshacer.")) return;

    try {
        const { error } = await supabaseClient.from('cartera').delete().eq('id', id);
        if (error) throw error;
        cartera_cerrarModal();
        await cartera_cargar();
    } catch (e) {
        alert("Error al eliminar: " + e.message);
    }
}

function cartera_abrirWhatsApp(celular) {
    if (!celular) return alert("El cliente no tiene celular registrado.");
    let phone = celular.replace(/\D/g, '');
    if (phone.length === 9) phone = "51" + phone;
    window.open(`https://wa.me/${phone}`, '_blank');
}

function cartera_exportarExcel() {
    if (typeof XLSX === 'undefined') {
        return alert("Error: Librería XLSX no encontrada.");
    }

    const q = document.getElementById("cartera-search").value.toLowerCase();
    const plan = document.getElementById("cartera-filtro-plan").value;
    const asesor = document.getElementById("cartera-filtro-asesor")?.value || 'todos';

    let exportData = allCartera.filter(c => {
        const txt = `${c.contratante} ${c.dni} ${c.celular}`.toLowerCase();
        if (q && !txt.includes(q)) return false;
        if (plan !== 'todos' && c.plan_salud !== plan) return false;
        if (asesor !== 'todos' && c.usuario !== asesor) return false;
        if (carteraFiltroEstado === 'aldia' && tieneMoroso(c)) return false;
        if (carteraFiltroEstado === 'morosos' && !tieneMoroso(c)) return false;
        if (carteraFiltroEstado === 'desafiliados' && !tieneDesafiliado(c)) return false;
        return true;
    }).map(c => ({
        "Fecha Afiliación": c.fecha_afiliacion,
        "Asesor": c.usuario,
        "Contratante": c.contratante,
        "DNI": c.dni,
        "Celular": c.celular || '',
        "Grupo Familiar": c.grupo_familiar,
        "Plan": c.plan_salud,
        "Calidad": c.calidad,
        "Afiliados": c.afiliados,
        "Mensualidad (S/)": c.mensualidad,
        "Bono (S/)": c.bono || 0,
        "M1": c.m1 || '', "M2": c.m2 || '', "M3": c.m3 || '', "M4": c.m4 || '',
        "M5": c.m5 || '', "M6": c.m6 || '', "M7": c.m7 || '', "M8": c.m8 || '',
        "M9": c.m9 || '', "M10": c.m10 || '', "M11": c.m11 || '', "M12": c.m12 || ''
    }));

    if (exportData.length === 0) {
        return alert("No hay datos para exportar con los filtros actuales.");
    }

    const ws = XLSX.utils.json_to_sheet(exportData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Cartera");
    XLSX.writeFile(wb, "Cartera_Clientes.xlsx");
}

async function cartera_recargarSilencioso() {
    try {
        const { data, error } = await supabaseClient
            .from('cartera')
            .select('*')
            .order('fecha_afiliacion', { ascending: false });
        if (error) return;
        allCartera = data || [];
        document.getElementById("cartera-sub-count").textContent = `${allCartera.length} cliente${allCartera.length !== 1 ? 's' : ''}`;

        const rol = leerSesion()?.rol;
        if (rol === "Administrador") cartera_poblarSelectAsesores();

        cartera_aplicarFiltros();
    } catch (e) {
        // Silencioso
    }
}

/* ══════════════════════════════════════════════
   MODULO DE CALIDAD (VALIDACIONES) - CRUD & UI
══════════════════════════════════════════════ */
function cal_init() {
    cal_cargar();
}

async function cal_cargar() {
    const session = leerSesion();
    const rol = session?.rol;
    const miUser = session?.usuario;

    try {
        let query = supabaseClient.from('calidad').select('*').order('dia', { ascending: true });

        if (rol !== "Administrador") {
            query = query.eq('usuario', miUser);
        }

        const { data, error } = await query;
        if (error) {
            console.error("Error cargando calidad:", error);
            return;
        }
        allCalidad = data || [];

        // Mostrar u ocultar botón de exportar Excel basado en el rol de Administrador
        const btnExportar = document.getElementById("cal-btn-exportar");
        if (btnExportar) {
            if (rol === "Administrador") {
                btnExportar.style.display = "inline-flex";
            } else {
                btnExportar.style.display = "none";
            }
        }

        const select = document.getElementById("cal-filtro-asesor");
        if (select) {
            if (rol === "Administrador") {
                select.style.display = "block";
                cal_poblarSelectAsesores();
            } else {
                select.style.display = "none";
            }
        }

        cal_renderTabla();
    } catch (e) {
        console.error("Error en cal_cargar:", e);
    }
}

function cal_poblarSelectAsesores() {
    const select = document.getElementById("cal-filtro-asesor");
    if (!select) return;
    const valActual = select.value;
    const asesores = [...new Set(allCalidad.map(c => c.usuario).filter(Boolean))];

    select.innerHTML = '<option value="">Todos los asesores</option>';
    asesores.forEach(a => {
        const opt = document.createElement("option");
        opt.value = a;
        opt.textContent = a;
        select.appendChild(opt);
    });
    select.value = valActual;
}

function cal_filtrar(status, btn) {
    calidadPaginaActual = 1;
    calidadFiltroStatus = status;
    const parent = btn.closest(".quick-filters");
    if (parent) {
        parent.querySelectorAll(".qf-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
    }
    cal_renderTabla();
}

function cal_renderTabla() {
    const container = document.getElementById("cal-tabla-container");
    if (!container) return;

    const session = leerSesion();
    const miUsuario = session?.usuario;
    const rol = session?.rol;

    const selectedAsesor = document.getElementById("cal-filtro-asesor")?.value || "";

    let filtered = allCalidad;

    // 1. Filtrar por Estado (Quick Filter)
    if (calidadFiltroStatus !== 'Todos') {
        filtered = filtered.filter(c => c.status === calidadFiltroStatus);
    }

    // 2. Filtrar por Asesor (Supervisor only)
    if (selectedAsesor) {
        filtered = filtered.filter(c => c.usuario === selectedAsesor);
    }

    if (filtered.length === 0) {
        container.innerHTML = `<div class="empty-state cartera-empty-state"><p>No se encontraron agendamientos.</p></div>`;
        return;
    }

    const totalItems = filtered.length;
    const totalPaginas = Math.ceil(totalItems / 15);

    if (calidadPaginaActual > totalPaginas) calidadPaginaActual = totalPaginas;
    if (calidadPaginaActual < 1) calidadPaginaActual = 1;

    const dataPaginada = filtered.slice((calidadPaginaActual - 1) * 15, calidadPaginaActual * 15);

    const isMobile = window.innerWidth <= 768;

    // Obtener fecha actual en formato local YYYY-MM-DD
    const hoy = new Date();
    const anio = hoy.getFullYear();
    const mes = String(hoy.getMonth() + 1).padStart(2, '0');
    const dia = String(hoy.getDate()).padStart(2, '0');
    const fechaHoyStr = `${anio}-${mes}-${dia}`;

    if (isMobile) {
        let html = ``;
        dataPaginada.forEach(c => {
            const puedeEditar = c.usuario === miUsuario || rol === 'Administrador';
            const statusClass = cal_obtenerStatusClass(c.status);

            const esAtrasada = c.dia < fechaHoyStr && c.status !== 'Llamada Ok';
            let diaHtml = ``;
            if (esAtrasada) {
                diaHtml = `
                <span style="background-color: #fee2e2; color: #dc2626; padding: 4px 8px; border-radius: var(--radius-sm); font-weight: 700; border: 1px solid #fecaca; display: inline-flex; align-items: center; gap: 4px; font-size: 0.85rem;" title="¡Urgente! Llamada retrasada">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width: 14px; height: 14px; flex-shrink:0;">
                        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                        <line x1="12" y1="9" x2="12" y2="13"/>
                        <line x1="12" y1="17" x2="12.01" y2="17"/>
                    </svg>
                    ${c.dia}
                </span>`;
            } else {
                diaHtml = `<span>${c.dia}</span>`;
            }

            html += `
            <div class="cartera-row-card" ${puedeEditar ? `onclick="cal_abrirModal('${c.id}')" style="cursor:pointer;" title="Click para editar"` : ''}>
                <div class="cartera-card-header">
                    <div>
                        <h4 class="cartera-card-title">${c.cliente}</h4>
                        <span class="cartera-card-plan" style="background:#f1f5f9; color:#475569; padding:2px 6px;">Grupo: ${c.grupo_familiar}</span>
                    </div>
                    <span class="status-chip ${statusClass}">${c.status || 'Pendiente'}</span>
                </div>
                <div style="font-size:0.8rem; color:var(--slate-600); margin-bottom:8px; line-height: 1.6; display:flex; flex-direction:column; gap:4px;">
                    <div><strong>Vendedor:</strong> ${c.usuario}</div>
                    <div style="display:flex; align-items:center; gap:8px;"><strong>Día:</strong> ${diaHtml} <strong>Hora:</strong> ${cal_formatearHora12(c.hora)}</div>
                </div>
                ${c.comentario ? `<div style="font-size:0.78rem; background:#f8fafc; padding:8px; border-radius:6px; border-left:3px solid #cbd5e1; color:#475569;">${c.comentario}</div>` : ''}
            </div>`;
        });
        container.innerHTML = `<div style="padding:1rem; display:flex; flex-direction:column; gap:1rem;">${html}</div>`;
    } else {
        let theadHtml = `
            <tr>
                <th class="cartera-th">Vendedor</th>
                <th class="cartera-th">Cliente</th>
                <th class="cartera-th">Grupo Familiar</th>
                <th class="cartera-th">Día de llamada</th>
                <th class="cartera-th">Hora</th>
                <th class="cartera-th">Comentario</th>
                <th class="cartera-th">Status</th>
            </tr>`;

        let tbodyHtml = ``;
        dataPaginada.forEach(c => {
            const puedeEditar = c.usuario === miUsuario || rol === 'Administrador';
            const statusClass = cal_obtenerStatusClass(c.status);

            const esAtrasada = c.dia < fechaHoyStr && c.status !== 'Llamada Ok';
            let diaHtml = ``;
            if (esAtrasada) {
                diaHtml = `
                <span style="background-color: #fee2e2; color: #dc2626; padding: 4px 8px; border-radius: var(--radius-sm); font-weight: 700; border: 1px solid #fecaca; display: inline-flex; align-items: center; gap: 4px; font-size: 0.85rem;" title="¡Urgente! Llamada retrasada">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width: 14px; height: 14px; flex-shrink:0;">
                        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                        <line x1="12" y1="9" x2="12" y2="13"/>
                        <line x1="12" y1="17" x2="12.01" y2="17"/>
                    </svg>
                    ${c.dia}
                </span>`;
            } else {
                diaHtml = `<span>${c.dia}</span>`;
            }

            tbodyHtml += `
            <tr class="cartera-tr" ${puedeEditar ? `onclick="cal_abrirModal('${c.id}')" style="cursor:pointer;" title="Click para editar"` : ''}>
                <td class="cartera-td">${c.usuario}</td>
                <td class="cartera-td cartera-td-nombre">${c.cliente}</td>
                <td class="cartera-td">${c.grupo_familiar}</td>
                <td class="cartera-td" style="white-space:nowrap; vertical-align: middle;">${diaHtml}</td>
                <td class="cartera-td" style="white-space:nowrap; vertical-align: middle;">${cal_formatearHora12(c.hora)}</td>
                <td class="cartera-td" style="max-width:250px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; vertical-align: middle;" title="${c.comentario || ''}">${c.comentario || '—'}</td>
                <td class="cartera-td" style="vertical-align: middle;"><span class="status-chip ${statusClass}">${c.status || 'Pendiente'}</span></td>
            </tr>`;
        });

        container.innerHTML = `
            <div class="cartera-table-wrap">
                <table class="cartera-table">
                    <thead>${theadHtml}</thead>
                    <tbody>${tbodyHtml}</tbody>
                </table>
            </div>`;
    }

    if (totalItems > 15) {
        let pagHtml = `<div class="pagination-container">`;
        for (let p = 1; p <= totalPaginas; p++) {
            pagHtml += `<button class="pagination-btn ${p === calidadPaginaActual ? 'active' : ''}" onclick="cal_cambiarPagina(${p})">${p}</button>`;
        }
        pagHtml += `</div>`;
        container.insertAdjacentHTML('beforeend', pagHtml);
    }
}

function cal_cambiarPagina(p) {
    calidadPaginaActual = p;
    cal_renderTabla();
}

function cal_cambiarFiltroAsesor() {
    calidadPaginaActual = 1;
    cal_renderTabla();
}

function cal_abrirExportModal() {
    const expPendiente = document.getElementById("cal-exp-pendiente");
    const expEnviado = document.getElementById("cal-exp-enviado");
    const expOk = document.getElementById("cal-exp-ok");
    const expNoContesto = document.getElementById("cal-exp-nocontesto");

    if (expPendiente) expPendiente.checked = true;
    if (expEnviado) expEnviado.checked = true;
    if (expOk) expOk.checked = false;
    if (expNoContesto) expNoContesto.checked = true;

    const overlay = document.getElementById("calidad-export-modal-overlay");
    if (overlay) {
        overlay.style.display = "flex";
        overlay.offsetHeight; // Forzar reflow para animación
        overlay.classList.add("active");
    }
    document.body.style.overflow = "hidden";
}

function cal_cerrarExportModal(e) {
    if (e && e.target !== e.currentTarget) return;
    const overlay = document.getElementById("calidad-export-modal-overlay");
    if (overlay) {
        overlay.classList.remove("active");
        setTimeout(() => {
            overlay.style.display = "none";
            document.body.style.overflow = "";
        }, 250);
    }
}

function cal_exportarExcelProcesar() {
    if (typeof XLSX === 'undefined') {
        return alert("Error: Librería XLSX no encontrada.");
    }

    const estados = [];
    if (document.getElementById("cal-exp-pendiente")?.checked) estados.push("Pendiente");
    if (document.getElementById("cal-exp-enviado")?.checked) estados.push("Enviado a Calidad");
    if (document.getElementById("cal-exp-ok")?.checked) estados.push("Llamada Ok");
    if (document.getElementById("cal-exp-nocontesto")?.checked) estados.push("No contestó");

    if (estados.length === 0) {
        return alert("Por favor, selecciona al menos un estado para exportar.");
    }

    const selectedAsesor = document.getElementById("cal-filtro-asesor")?.value || "";

    let exportData = allCalidad.filter(c => {
        if (!estados.includes(c.status)) return false;
        if (selectedAsesor && c.usuario !== selectedAsesor) return false;
        return true;
    });

    if (exportData.length === 0) {
        return alert("No hay datos para exportar con los estados seleccionados.");
    }

    const dataMapeada = exportData.map(c => ({
        "Vendedor": c.usuario || "",
        "Cliente": c.cliente || "",
        "Grupo Familiar": c.grupo_familiar || 0,
        "Día de llamada": c.dia || "",
        "Hora": cal_formatearHora12(c.hora) || "",
        "Comentario": c.comentario || "",
        "Status": c.status || "Pendiente"
    }));

    const ws = XLSX.utils.json_to_sheet(dataMapeada);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Validaciones");

    const hoy = new Date();
    const fechaStr = hoy.toISOString().slice(0, 10);
    XLSX.writeFile(wb, `Reporte_Validaciones_${fechaStr}.xlsx`);

    cal_cerrarExportModal();
}

function cal_obtenerStatusClass(status) {
    switch (status) {
        case 'Pendiente': return 'pendiente';
        case 'Enviado a Calidad': return 'enviado';
        case 'Llamada Ok': return 'llamada-ok';
        case 'No contestó': return 'no-contesto';
        default: return 'pendiente';
    }
}

function cal_formatearHora12(timeString) {
    if (!timeString) return '—';
    const parts = timeString.split(':');
    if (parts.length < 2) return timeString;
    let hours = parseInt(parts[0], 10);
    const minutesStr = parts[1];
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    hours = hours ? hours : 12; // la hora '0' debe ser '12'
    return `${hours}:${minutesStr} ${ampm}`;
}

function cal_abrirModal(id = null) {
    calidadEditandoId = id;
    const form = document.getElementById("cal-form");
    if (form) form.reset();

    document.getElementById("cal-modal-title").textContent = id ? "Editar Agendamiento" : "Agendar Llamada";

    const delWrap = document.getElementById("cal-btn-eliminar-wrap");
    if (delWrap) delWrap.innerHTML = "";

    if (id) {
        // Modo Edición: Mostrar dropdown de Status
        document.getElementById("cal-status-wrap").style.display = "block";
        const c = allCalidad.find(x => x.id === id);
        if (c) {
            document.getElementById("cal-cliente").value = c.cliente || '';
            document.getElementById("cal-grupo").value = c.grupo_familiar || '';
            document.getElementById("cal-dia").value = c.dia || '';
            document.getElementById("cal-hora").value = c.hora || '';
            document.getElementById("cal-status").value = c.status || 'Pendiente';
            document.getElementById("cal-comentario").value = c.comentario || '';

            const miUsuario = leerSesion()?.usuario;
            const rol = leerSesion()?.rol;
            if (c.usuario === miUsuario || rol === 'Administrador') {
                delWrap.innerHTML = `<button type="button" class="btn-cancel" style="background:#fee2e2; color:#dc2626; border-color:#fecaca;" onclick="cal_eliminar('${id}')">Eliminar</button>`;
            }
        }
    } else {
        // Modo Creación: Ocultar dropdown (se guardará por defecto como 'Pendiente')
        document.getElementById("cal-status-wrap").style.display = "none";
    }

    const overlay = document.getElementById("calidad-modal-overlay");
    if (overlay) {
        overlay.style.display = "flex";
        overlay.offsetHeight; // Forzar reflow para animación
        overlay.classList.add("active");
    }
    document.body.style.overflow = "hidden";
}

function cal_cerrarModal(event = null) {
    if (event && event.target !== event.currentTarget) return;
    const overlay = document.getElementById("calidad-modal-overlay");
    if (overlay) {
        overlay.classList.remove("active");
        document.body.style.overflow = "";
        setTimeout(() => { overlay.style.display = "none"; }, 250);
    }
}

async function cal_guardar(e) {
    e.preventDefault();
    const miUsuario = leerSesion()?.usuario;

    const cliente = document.getElementById("cal-cliente").value.trim();
    const grupo = parseInt(document.getElementById("cal-grupo").value, 10);
    const dia = document.getElementById("cal-dia").value;
    const hora = document.getElementById("cal-hora").value;
    const comentario = document.getElementById("cal-comentario").value.trim();

    // Si estamos editando leemos el status, si no se guarda como 'Pendiente' por defecto
    const status = calidadEditandoId ? document.getElementById("cal-status").value : 'Pendiente';

    const payload = {
        cliente,
        grupo_familiar: grupo,
        dia,
        hora,
        comentario,
        status
    };

    try {
        if (calidadEditandoId) {
            // Actualizar
            const { error } = await supabaseClient
                .from('calidad')
                .update(payload)
                .eq('id', calidadEditandoId);
            if (error) throw error;
            mostrarToast("Agendamiento actualizado");
        } else {
            // Crear nuevo
            payload.usuario = miUsuario;
            const { error } = await supabaseClient
                .from('calidad')
                .insert([payload]);
            if (error) throw error;
            mostrarToast("Llamada agendada");
        }

        cal_cerrarModal();
        cal_cargar(); // Recargar datos
    } catch (err) {
        console.error("Error guardando:", err);
        alert("Error al guardar: " + err.message);
    }
}

async function cal_eliminar(id) {
    if (!confirm("¿Estás seguro de que deseas eliminar este agendamiento?")) return;
    try {
        const { error } = await supabaseClient
            .from('calidad')
            .delete()
            .eq('id', id);
        if (error) throw error;
        mostrarToast("Agendamiento eliminado");
        cal_cerrarModal();
        cal_cargar();
    } catch (err) {
        console.error("Error eliminando:", err);
        alert("Error al eliminar: " + err.message);
    }
}

async function cal_recargarSilencioso() {
    const session = leerSesion();
    const rol = session?.rol;
    const miUser = session?.usuario;

    try {
        let query = supabaseClient.from('calidad').select('*').order('dia', { ascending: true });
        if (rol !== "Administrador") {
            query = query.eq('usuario', miUser);
        }
        const { data, error } = await query;
        if (error) return;
        allCalidad = data || [];

        // Mostrar u ocultar botón de exportar Excel basado en el rol de Administrador
        const btnExportar = document.getElementById("cal-btn-exportar");
        if (btnExportar) {
            if (rol === "Administrador") {
                btnExportar.style.display = "inline-flex";
            } else {
                btnExportar.style.display = "none";
            }
        }

        if (rol === "Administrador") cal_poblarSelectAsesores();
        cal_renderTabla();
    } catch (e) {
        // Silencioso
    }
}

function mostrarToast(mensaje) {
    const toast = document.getElementById("toast-edit");
    if (toast) {
        toast.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" /></svg> ${mensaje}`;
        toast.style.display = "flex";
        setTimeout(() => { toast.style.display = "none"; }, 3000);
    }
}
