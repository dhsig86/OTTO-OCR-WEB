import { useEffect, useRef, useState } from 'react';
import { FileUp, Loader2, AlertTriangle, CheckCircle2, FileText, Copy, ClipboardCheck } from 'lucide-react';

const OCR_BASE_URL = 'https://otto-ocr-api.onrender.com';
const ACCEPTED_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/jpg'];
const OCR_UPLOAD_TIMEOUT_MS = 60000;
const POLL_INTERVAL_MS = 3000;
const POLL_MAX_ATTEMPTS = 40;

const normalizeFindings = (input) => {
  if (Array.isArray(input)) return input.filter(Boolean).map((item) => String(item).trim()).filter(Boolean);
  if (typeof input === 'string' && input.trim()) {
    return input
      .split('\n')
      .map((item) => item.replace(/^[\s*-]+/, '').trim())
      .filter(Boolean);
  }
  return [];
};

const OCR_SESSION_KEY = 'otto-ocr-pwa.v1';

export default function App() {
  const fileInputRef = useRef(null);
  const pollIntervalRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [selectedFileName, setSelectedFileName] = useState('');
  
  const [ocrResult, setOcrResultState] = useState(() => {
    try {
      const raw = sessionStorage.getItem(OCR_SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  });
  
  const [errorMessage, setErrorMessage] = useState('');
  const [copied, setCopied] = useState(false);
  const [toastMessage, setToastMessage] = useState('');
  const [selectedExamType, setSelectedExamType] = useState('auto');

  const showToast = (msg) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(''), 3000);
  };

  const setOcrResult = (data) => {
    setOcrResultState(data);
    try {
      if (data) sessionStorage.setItem(OCR_SESSION_KEY, JSON.stringify(data));
      else sessionStorage.removeItem(OCR_SESSION_KEY);
    } catch {}
  };

  const hasResult = Boolean(ocrResult?.summary || (ocrResult?.findings || []).length > 0);

  const MAX_Bytes = 10 * 1024 * 1024; // 10MB limite OCR backend

  const stopPolling = () => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
  };

  const pollResult = (jobId) => {
    let attempts = 0;
    stopPolling();

    pollIntervalRef.current = setInterval(async () => {
      attempts++;
      try {
        const res = await fetch(`${OCR_BASE_URL}/ocr/${jobId}/result`);
        if (!res.ok) throw new Error(`Erro API: ${res.status}`);
        const data = await res.json();

        setStatusMessage(data.message || `Aguardando processamento... (${(attempts * 3)}s)`);

        if (data.status === 'completed') {
          stopPolling();
          setIsLoading(false);
          setStatusMessage('');
          const ci = data.result?.clinical_interpretation || {};
          const summary = typeof ci.summary === 'string' ? ci.summary.trim() : '';
          const findings = normalizeFindings(ci.findings);
          const diagnostic = normalizeFindings(ci.diagnostics);
          const examDate = data.result?.exam_date || '';
          const succinctInsight = typeof ci.succinct_insight === 'string' ? ci.succinct_insight.trim() : '';
          
          if (!summary && findings.length === 0) {
            setErrorMessage('Arquivo processado, mas dados estruturados vazios.');
          } else {
            setOcrResult({ summary, findings, examDate, diagnostic, succinctInsight });
            showToast('Extração finalizada com sucesso!');
          }
        } else if (data.status === 'low_confidence') {
          stopPolling();
          setIsLoading(false);
          setStatusMessage('');
          setErrorMessage(data.message || 'Qualidade de imagem insuficiente para extração.');
        } else if (data.status === 'failed') {
          stopPolling();
          setIsLoading(false);
          setStatusMessage('');
          setErrorMessage(data.message || 'Falha no OCR. Recarregue a página e tente novamente.');
        }
      } catch (err) {
        if (attempts >= POLL_MAX_ATTEMPTS) {
          stopPolling();
          setIsLoading(false);
          setErrorMessage('Timeout de conexão. Processamento demorou mais do que o esperado.');
        }
      }

      if (attempts >= POLL_MAX_ATTEMPTS) {
        stopPolling();
        setIsLoading(false);
        setErrorMessage('Timeout de processamento (120s ultrapassados).');
      }
    }, POLL_INTERVAL_MS);
  };

  const processFile = async (file) => {
    if (!file) return;
    if (!ACCEPTED_TYPES.includes(file.type)) {
      setErrorMessage('Formato inválido. Envie PDF, PNG ou JPG.');
      return;
    }
    if (file.size > MAX_Bytes) {
      setErrorMessage(`Arquivo muito grande (máx 10MB).`);
      return;
    }

    stopPolling();
    setSelectedFileName(file.name);
    setErrorMessage('');
    setIsLoading(true);
    setOcrResult(null);
    setStatusMessage('Enviando via conexão segura para o OCR...');

    try {
      const abortController = new AbortController();
      const timeoutId = setTimeout(() => abortController.abort(), OCR_UPLOAD_TIMEOUT_MS);
      
      const body = new FormData();
      body.append('file', file);
      body.append('exam_type', selectedExamType);

      const response = await fetch(`${OCR_BASE_URL}/ocr/upload`, {
        method: 'POST',
        body,
        signal: abortController.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error('Falha no upload do documento.');
      }

      const json = await response.json();
      if (!json.job_id) throw new Error('Job ID não retornado pelo servidor.');

      setStatusMessage('Iniciando orquestração inteligente...');
      pollResult(json.job_id);
    } catch (e) {
      setIsLoading(false);
      setStatusMessage('');
      setErrorMessage(e.message || 'Erro de rede. Verifique sua conexão e tente de novo.');
    }
  };

  const handleCopy = () => {
    if (!hasResult) return;
    const dateStr = ocrResult.examDate ? `Data do Exame: ${ocrResult.examDate}\n` : '';
    const findingsText = (ocrResult.findings || []).map((f) => `- ${f}`).join('\n');
    const diagText = (ocrResult.diagnostic || []).map((f) => `- ${f}`).join('\n');
    
    let text = `--- RESULTADOS (Via OTTO OCR) ---\n${dateStr}\n${ocrResult.summary || ''}\n\n[ACHADOS RELEVANTES]\n${findingsText || '- Nenhum achado estruturado destacado.'}`;
    if(diagText) {
      text += `\n\n[DIAGNÓSTICOS / IMPRESSÃO]\n${diagText}`;
    }

    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(() => {
        setCopied(true);
        showToast('Texto integral copiado!');
        setTimeout(() => setCopied(false), 2500);
      }).catch(() => fallbackCopy(text));
    } else {
      fallbackCopy(text);
    }
  };

  const handleCopySuccinct = () => {
    if (!hasResult) return;
    const dateStr = ocrResult.examDate ? `${ocrResult.examDate} - ` : '';
    let text = `${dateStr}${ocrResult.succinctInsight || ocrResult.summary || ''}`;
    
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(() => {
        setCopied(true);
        showToast('Resumo Prontuário copiado!');
        setTimeout(() => setCopied(false), 2500);
      }).catch(() => fallbackCopy(text));
    } else {
      fallbackCopy(text);
    }
  };

  const fallbackCopy = (text) => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '0';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try {
      document.execCommand('copy');
      setCopied(true);
      showToast('Copiado!');
      setTimeout(() => setCopied(false), 2500);
    } catch (err) {
      setErrorMessage("Erro ao copiar para área de transferência.");
    }
    document.body.removeChild(ta);
  };

  return (
    <div className="min-h-screen bg-slate-50 relative pb-10">
      {/* Header Minimalista */}
      <header className="sticky top-0 z-50 bg-white/80 backdrop-blur-md border-b border-slate-200 px-5 py-4 flex items-center gap-3 shadow-sm">
        <div className="w-8 h-8 rounded-lg bg-teal-600 font-bold text-white flex items-center justify-center">O</div>
        <h1 className="font-bold text-lg text-slate-800 tracking-tight">OTTO OCR</h1>
        <div className="ml-auto flex items-center gap-2 text-xs font-semibold px-3 py-1 bg-slate-100 text-teal-700 rounded-full border border-slate-200">
           🛡️ HIPAA & LGPD
        </div>
      </header>

      {/* Main Content */}
      <main className="mx-auto w-full max-w-3xl p-4 md:p-6 mt-4 space-y-5">
        
        {/* Helper Banner & Tutorial */}
        <div className="text-center px-4 mb-6">
          <h2 className="text-xl md:text-2xl font-bold text-slate-800 tracking-tight mb-2">Visão Computacional Clínica</h2>
          <p className="text-sm md:text-base text-slate-500 mb-4">Envie um laudo escaneado ou PDF nativo para transformá-lo estruturalmente em insights médicos via agentes OTTO.</p>
          
          <div className="bg-white p-4 rounded-2xl border border-slate-200 text-left text-sm text-slate-600 shadow-sm max-w-2xl mx-auto mb-6">
            <p className="font-semibold text-slate-800 mb-2 flex items-center gap-2">💡 Dicas para Scans Perfeitos:</p>
            <ul className="list-disc pl-5 space-y-1">
              <li>Evite reflexos de luz em exames impressos.</li>
              <li>A detecção de tipo é automática, mas em caso de falha, você pode forçar o modelo de exame abaixo.</li>
              <li>Epônimos serão mantidos, mas idiomas estrangeiros no visor do aparelho serão traduzidos para o Português.</li>
            </ul>
          </div>
          
          <div className="max-w-xs mx-auto">
            <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1 text-left">Forçar Tipo de Exame</label>
            <select 
              value={selectedExamType} 
              onChange={(e) => setSelectedExamType(e.target.value)}
              className="w-full bg-white border border-slate-300 text-slate-700 text-sm rounded-xl focus:ring-teal-500 focus:border-teal-500 block p-2.5 shadow-sm"
            >
              <option value="auto">Detecção Automática (Recomendado)</option>
              <option value="tomografia">Tomografia de Face</option>
              <option value="endoscopia_nasal">Videoendoscopia Nasal</option>
              <option value="videolaringoscopia">Videolaringoscopia</option>
              <option value="audiometria">Audiometria</option>
              <option value="bera">BERA / PEATE</option>
              <option value="polissonografia">Polissonografia</option>
            </select>
          </div>
        </div>

        {/* Upload Zone */}
        <section className="bg-white rounded-3xl border border-slate-200 shadow-sm p-4 md:p-6">
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
            onChange={(e) => {
              if (e.target.files?.[0]) processFile(e.target.files[0]);
              e.target.value = '';
            }}
          />

          <button
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={(e) => { e.preventDefault(); setDragging(false); }}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              if (e.dataTransfer?.files?.[0]) processFile(e.dataTransfer.files[0]);
            }}
            className={`w-full rounded-2xl border-2 border-dashed p-6 transition-all duration-200 min-h-[160px] flex flex-col items-center justify-center gap-4 ${
              dragging ? 'border-teal-400 bg-teal-50/50' : 'border-slate-300 bg-slate-50/50 hover:border-teal-300 hover:bg-teal-50'
            }`}
          >
            <div className="w-14 h-14 rounded-2xl bg-teal-600 text-white flex items-center justify-center shadow-lg shadow-teal-600/20">
              <FileUp size={28} />
            </div>
            <div className="text-center">
              <p className="font-semibold text-slate-700 md:text-lg">Toque para selecionar o arquivo</p>
              <p className="text-xs text-slate-500 mt-1 md:text-sm">Ou arraste PDF, PNG, JPG (Máx. 10MB)</p>
            </div>
            {selectedFileName && !isLoading && !errorMessage && (
               <span className="text-xs font-semibold text-teal-600 mt-2 bg-teal-100 px-3 py-1 rounded-full">Exame: {selectedFileName}</span>
            )}
          </button>
        </section>

        {/* Loading State */}
        {isLoading && (
          <div className="bg-white rounded-3xl border border-teal-200 p-5 shadow-sm overflow-hidden relative">
            <div className="flex items-center gap-4">
              <div className="animate-spin text-teal-600"><Loader2 size={24} /></div>
              <div>
                <p className="font-bold text-slate-800">Extraindo Dados...</p>
                <p className="text-sm text-slate-500">{statusMessage}</p>
              </div>
            </div>
            <div className="w-full bg-slate-100 h-1 mt-5 rounded-full overflow-hidden">
               <div className="h-full bg-teal-500 w-1/2 rounded-full animate-[pulse_1.5s_ease-in-out_infinite] translate-x-0 origin-left" style={{animation: 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite, slide 3s linear infinite alternate'}}/>
            </div>
          </div>
        )}

        {/* Error State */}
        {errorMessage && (
          <div className="bg-red-50 border border-red-200 rounded-2xl p-5 flex items-start gap-3 shadow-sm">
            <AlertTriangle className="text-red-500 shrink-0 mt-0.5" size={20} />
            <div>
              <p className="font-bold text-red-800">Bloqueio de Extração</p>
              <p className="text-sm text-red-700 mt-1">{errorMessage}</p>
              <button onClick={() => setErrorMessage('')} className="text-xs font-bold bg-white text-red-700 px-3 py-1.5 rounded-lg border border-red-200 mt-3 hover:bg-red-100">
                TENTAR OUTRO ARQUIVO
              </button>
            </div>
          </div>
        )}

        {/* Results */}
        {ocrResult && (
          <div className="space-y-4 animate-in fade-in slide-in-from-bottom-6 duration-500">
            {ocrResult.examDate && (
              <div className="flex items-center gap-2 bg-indigo-50 border border-indigo-100 rounded-xl px-4 py-2.5 text-sm font-semibold text-indigo-800 w-max shadow-sm">
                <span>🗓️ Data do Documento:</span>
                <span className="text-indigo-950 font-bold">{ocrResult.examDate}</span>
              </div>
            )}
            
            <div className="bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden">
              <div className="p-5 md:p-6 space-y-6">
                
                {/* Summary */}
                <div className="space-y-3">
                  <div className="flex items-center gap-2 text-teal-700 font-bold tracking-tight text-sm uppercase">
                    <CheckCircle2 size={18} />
                    <span>Resumo Clínico</span>
                  </div>
                  <p className="text-slate-700 leading-relaxed bg-slate-50 p-4 rounded-2xl border border-slate-100 text-[15px]">
                    {ocrResult.summary || 'Resumo clínico abstrato indisponível.'}
                  </p>
                </div>

                {/* Grid for findings and diagnostics */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                  <div className="space-y-3">
                     <div className="flex items-center gap-2 text-amber-600 font-bold tracking-tight text-sm uppercase">
                       <FileText size={18} /><span>Achados Específicos</span>
                     </div>
                     <ul className="space-y-2">
                       {ocrResult.findings?.length ? ocrResult.findings.map((f, i) => (
                         <li key={i} className="flex gap-2 text-[15px] text-slate-700 items-start leading-snug">
                           <span className="text-amber-500 font-bold shrink-0 mt-0.5">•</span>
                           <span>{f}</span>
                         </li>
                       )) : <li className="text-sm text-slate-400 italic">Nenhum achado mapeado isoladamente.</li>}
                     </ul>
                  </div>

                  <div className="space-y-3">
                     <div className="flex items-center gap-2 text-indigo-600 font-bold tracking-tight text-sm uppercase">
                       <FileText size={18} /><span>Diagnósticos</span>
                     </div>
                     <ul className="space-y-2">
                       {ocrResult.diagnostic?.length ? ocrResult.diagnostic.map((f, i) => (
                         <li key={i} className="flex gap-2 text-[15px] text-slate-700 items-start leading-snug">
                           <span className="text-indigo-500 font-bold shrink-0 mt-0.5">→</span>
                           <span>{f}</span>
                         </li>
                       )) : <li className="text-sm text-slate-400 italic">Nenhum diagnóstico categorizado.</li>}
                     </ul>
                  </div>
                </div>

              </div>

              {/* Action Footer */}
              <div className="bg-slate-50 border-t border-slate-200 p-4 md:p-5 flex flex-col md:flex-row items-center gap-3 justify-between">
                 <p className="text-xs text-slate-500 max-w-xs text-center md:text-left">Use essa transcrição para compor a história clínica do painel.</p>
                 
                 <div className="flex flex-col sm:flex-row w-full md:w-auto gap-2">
                   <button
                    onClick={handleCopy}
                    className={`flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl font-bold shadow-sm transition-all text-sm active:scale-95 ${
                      copied 
                        ? 'bg-emerald-100 text-emerald-800 ring-1 ring-emerald-300' 
                        : 'bg-white text-teal-700 border border-teal-200 hover:bg-teal-50'
                    }`}
                   >
                     {copied ? <ClipboardCheck size={18}/> : <FileText size={18}/>}
                     Cópia Integral
                   </button>
                   <button
                    onClick={handleCopySuccinct}
                    className={`flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl font-bold shadow-sm transition-all text-sm active:scale-95 ${
                      copied 
                        ? 'bg-emerald-100 text-emerald-800 ring-1 ring-emerald-300' 
                        : 'bg-teal-600 text-white hover:bg-teal-700 shadow-teal-500/20 hover:shadow-teal-500/30'
                    }`}
                   >
                     {copied ? <ClipboardCheck size={18}/> : <Copy size={18}/>}
                     Resumo (Prontuário)
                   </button>
                 </div>
              </div>

            </div>
          </div>
        )}
      </main>

      {/* Global Toast */}
      {toastMessage && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 animate-in slide-in-from-bottom-10 fade-in duration-300">
          <div className="bg-slate-900 text-white font-semibold text-sm px-5 py-3 rounded-full shadow-lg shadow-black/20 flex items-center gap-2">
            <CheckCircle2 size={16} className="text-teal-400"/>
            {toastMessage}
          </div>
        </div>
      )}
    </div>
  );
}
