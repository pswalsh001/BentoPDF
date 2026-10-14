// Desktop wrapper integration. Loaded only when the app runs inside the Tauri
// shell: file inputs open a native dialog (so the app learns where a file
// lives), files dropped on the window are routed to the page, and finished
// results can be written back over the file they came from.
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { showAlert } from '../ui.js';
import {
  acceptToExtensions,
  chooseSaveMode,
  mimeFromName,
  type DesktopSource,
} from './desktop-file-rules.js';

interface DroppedFiles {
  files: DesktopSource[];
  x: number;
  y: number;
}

type OverwriteChoice = 'overwrite' | 'save-as' | 'cancel';

// Every file handed to this page since it loaded. Overwrite is only offered
// while this holds exactly one PDF.
const sources: DesktopSource[] = [];

function rememberSources(picked: DesktopSource[]): void {
  for (const file of picked) {
    if (!sources.some((source) => source.id === file.id)) sources.push(file);
  }
}

async function loadIntoInput(
  input: HTMLInputElement,
  picked: DesktopSource[]
): Promise<void> {
  const wanted = input.multiple ? picked : picked.slice(0, 1);
  if (wanted.length === 0) return;

  const files = await Promise.all(
    wanted.map(async (source) => {
      const bytes = await invoke<ArrayBuffer>('read_file', { id: source.id });
      return new File([bytes], source.name, {
        type: mimeFromName(source.name),
      });
    })
  );

  const transfer = new DataTransfer();
  files.forEach((file) => transfer.items.add(file));
  input.files = transfer.files;
  rememberSources(wanted);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

async function pickInto(input: HTMLInputElement): Promise<void> {
  try {
    const picked = await invoke<DesktopSource[]>('pick_files', {
      multiple: input.multiple,
      extensions: acceptToExtensions(input.accept),
    });
    await loadIntoInput(input, picked);
  } catch (error) {
    showAlert('Could not open file', String(error));
  }
}

function fileInputNear(element: Element | null): HTMLInputElement | null {
  for (let node = element; node; node = node.parentElement) {
    const input = node.querySelector<HTMLInputElement>('input[type="file"]');
    if (input) return input;
  }
  return document.querySelector<HTMLInputElement>('input[type="file"]');
}

function askOverwrite(name: string): Promise<OverwriteChoice> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className =
      'fixed inset-0 bg-gray-900 bg-opacity-90 flex items-center justify-center z-50';

    const panel = document.createElement('div');
    panel.className =
      'bg-gray-800 rounded-lg shadow-xl p-6 max-w-sm w-full border border-gray-700';

    const title = document.createElement('h3');
    title.className = 'text-xl font-bold text-white mb-2';
    title.textContent = 'Save changes';

    const message = document.createElement('p');
    message.className = 'text-gray-300 mb-6 break-words';
    message.textContent = `Overwrite ${name}, or save the result as a new file? Overwriting cannot be undone.`;

    const finish = (choice: OverwriteChoice) => {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve(choice);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') finish('cancel');
    };

    const button = (label: string, style: string, choice: OverwriteChoice) => {
      const element = document.createElement('button');
      element.className = `w-full ${style} text-white font-semibold py-2 px-4 rounded-lg transition-colors duration-200 mb-2`;
      element.textContent = label;
      element.addEventListener('click', () => finish(choice));
      return element;
    };

    panel.append(
      title,
      message,
      button(
        'Overwrite original',
        'bg-indigo-600 hover:bg-indigo-700',
        'overwrite'
      ),
      button('Save as new file', 'bg-gray-600 hover:bg-gray-500', 'save-as'),
      button('Cancel', 'bg-gray-700 hover:bg-gray-600', 'cancel')
    );
    overlay.append(panel);
    document.addEventListener('keydown', onKey);
    document.body.append(overlay);
  });
}

async function saveAs(
  bytes: Uint8Array,
  filename: string,
  near: DesktopSource | null
): Promise<void> {
  const headers: Record<string, string> = {
    'x-suggested-name': encodeURIComponent(filename),
  };
  if (near) headers['x-near-file-id'] = String(near.id);

  const savedName = await invoke<string | null>('save_file_as', bytes, {
    headers,
  });
  if (savedName) showAlert('Saved', `Saved as ${savedName}.`, 'success');
}

export async function saveFromDesktop(
  blob: Blob,
  filename: string
): Promise<void> {
  try {
    const decision = chooseSaveMode(sources, blob.type, filename);
    const bytes = new Uint8Array(await blob.arrayBuffer());

    if (decision.mode === 'save-as') {
      await saveAs(bytes, filename, decision.near);
      return;
    }

    const choice = await askOverwrite(decision.source.name);
    if (choice === 'overwrite') {
      await invoke('overwrite_file', bytes, {
        headers: { 'x-file-id': String(decision.source.id) },
      });
      showAlert('Saved', `Replaced ${decision.source.name}.`, 'success');
    } else if (choice === 'save-as') {
      await saveAs(bytes, filename, decision.source);
    }
  } catch (error) {
    showAlert('Could not save file', String(error));
  }
}

export function initDesktopBridge(): void {
  // Capture phase, so this runs before the browser opens its own file chooser
  // and regardless of how a tool triggers its input.
  document.addEventListener(
    'click',
    (event) => {
      const input = event.target;
      if (
        !(input instanceof HTMLInputElement) ||
        input.type !== 'file' ||
        input.webkitdirectory
      ) {
        return;
      }
      event.preventDefault();
      void pickInto(input);
    },
    true
  );

  void listen<DroppedFiles>('desktop-files-dropped', ({ payload }) => {
    const scale = window.devicePixelRatio || 1;
    const target = document.elementFromPoint(
      payload.x / scale,
      payload.y / scale
    );
    const input = fileInputNear(target);
    if (!input) return;
    loadIntoInput(input, payload.files).catch((error) =>
      showAlert('Could not open file', String(error))
    );
  });
}
