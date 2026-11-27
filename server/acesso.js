import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  ADMIN_HORAS,
  SENHA_AMBIENTE,
  SENHA_ARQUIVO,
  USUARIO_AMBIENTE,
  VISITA_DIAS,
  VISITA_TOKEN,
} from './config.js';

export const COOKIE_ACESSO = 'expedicao_acesso';
export const COOKIE_ADMIN = 'expedicao_admin';

const assinar = (conteudo) =>
  createHmac('sha256', VISITA_TOKEN).update(conteudo).digest('base64url');

const iguais = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

const cookie = (nome, prefixo, segundos) => {
  const conteudo = `${prefixo}.${Date.now() + segundos * 1000}`;
  return `${nome}=${conteudo}.${assinar(conteudo)}; Path=/; Max-Age=${segundos}; HttpOnly; SameSite=Lax`;
};

export const headerCookieAcesso = () => cookie(COOKIE_ACESSO, 'acesso', VISITA_DIAS * 86_400);
export const headerCookieAdmin = () => cookie(COOKIE_ADMIN, 'admin', ADMIN_HORAS * 3600);
export const headerCookieSair = () => `${COOKIE_ADMIN}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;

function temCookieValido(req, nome, prefixo) {
  const bruto = String(req.headers.cookie ?? '')
    .split(';')
    .map((parte) => parte.trim())
    .find((parte) => parte.startsWith(`${nome}=`))
    ?.slice(nome.length + 1);
  if (!bruto) return false;
  const corte = bruto.lastIndexOf('.');
  if (corte <= 0) return false;
  const conteudo = bruto.slice(0, corte);
  if (!iguais(bruto.slice(corte + 1), assinar(conteudo))) return false;
  const [cabeca, expira] = conteudo.split('.');
  return cabeca === prefixo && Number(expira) > Date.now();
}

/** Confere o token do link sem vazar tempo de resposta proporcional ao acerto. */
export const tokenOk = (candidato) => iguais(candidato, VISITA_TOKEN);
export const usuarioOk = (candidato) => iguais(candidato, USUARIO_AMBIENTE);

let hashCache = null;

const hashGuardado = () => {
  if (hashCache !== null) return hashCache;
  try {
    const texto = fs.readFileSync(SENHA_ARQUIVO, 'utf8').trim();
    hashCache = texto.startsWith('scrypt$') ? texto : '';
  } catch {
    hashCache = '';
  }
  return hashCache;
};

export const senhaDefinida = () => Boolean(hashGuardado() || SENHA_AMBIENTE);

export function conferirSenha(candidata) {
  const guardado = hashGuardado();
  if (guardado) {
    const [, salt, hash] = guardado.split('$');
    if (!salt || !hash) return false;
    const calculado = scryptSync(String(candidata ?? ''), Buffer.from(salt, 'hex'), 64);
    return iguais(calculado.toString('hex'), hash);
  }
  if (SENHA_AMBIENTE) return iguais(candidata, SENHA_AMBIENTE);
  return false;
}

export function conferirCredenciais(usuario, senha) {
  const usuarioValido = usuarioOk(usuario);
  const senhaValida = conferirSenha(senha);
  return usuarioValido && senhaValida;
}

export function definirSenha(nova) {
  const texto = String(nova ?? '');
  if (texto.length < 4) throw new Error('a senha precisa ter pelo menos 4 caracteres');
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(texto, Buffer.from(salt, 'hex'), 64).toString('hex');
  fs.mkdirSync(path.dirname(SENHA_ARQUIVO), { recursive: true });
  fs.writeFileSync(SENHA_ARQUIVO, `scrypt$${salt}$${hash}\n`);
  hashCache = `scrypt$${salt}$${hash}`;
}

const noTunel = (endereco) =>
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(String(endereco ?? ''));

/**
 * Quem chega pelo túnel precisa do cookie do link; sem ele o acesso é negado (link expirado não
 * vira acesso da rede local). A senha só muda o nível: sem ela a pessoa acompanha e marca entregas,
 * com ela abre a importação e os ajustes. Enquanto o escritório não cria a senha, quem vem de fora
 * fica no nível de trabalho — a administração fica só na rede local.
 */
export function decidir(req) {
  if (noTunel(req.socket?.localAddress) || noTunel(req.socket?.remoteAddress)) {
    if (!temCookieValido(req, COOKIE_ACESSO, 'acesso')) return 'negar';
    if (!senhaDefinida()) return 'operacao';
  }
  if (!senhaDefinida()) return 'administracao';
  return temCookieValido(req, COOKIE_ADMIN, 'admin') ? 'administracao' : 'operacao';
}

export function papel(req) {
  const decisao = decidir(req);
  return decisao === 'negar' ? 'operacao' : decisao;
}

const MAX_FALTAS = 5;
const JANELA_MS = 15 * 60 * 1000;
const tentativas = new Map();

export function bloqueado(ip) {
  const registro = tentativas.get(ip);
  if (!registro) return false;
  if (Date.now() - registro.janela > JANELA_MS) {
    tentativas.delete(ip);
    return false;
  }
  return registro.faltas >= MAX_FALTAS;
}

function podar() {
  if (tentativas.size < 500) return;
  const agora = Date.now();
  for (const [ip, registro] of tentativas) {
    if (agora - registro.janela > JANELA_MS) tentativas.delete(ip);
  }
}

export function registrarFalta(ip) {
  podar();
  const registro = tentativas.get(ip) ?? { faltas: 0, janela: Date.now() };
  if (Date.now() - registro.janela > JANELA_MS) {
    registro.faltas = 0;
    registro.janela = Date.now();
  }
  registro.faltas += 1;
  tentativas.set(ip, registro);
}

export const limparFaltas = (ip) => tentativas.delete(ip);
