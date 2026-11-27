import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  converterData,
  converterNumero,
  dataIso,
  formatarData,
  formatarMoeda,
  formatarNumero,
  isoParaData,
  localizarOpcao,
  normalizarBusca,
} from '../src/emissor/formato.ts';

test('números pt-BR', () => {
  assert.equal(converterNumero('1.234,56'), 1234.56);
  assert.equal(converterNumero('1.234'), 1234);
  assert.equal(converterNumero('19,50'), 19.5);
  assert.equal(converterNumero('645'), 645);
  assert.equal(converterNumero(' 12.5 '), 12.5);
  assert.equal(converterNumero('abc'), null);
  assert.equal(converterNumero(''), null);
});

test('formatação de números e moeda', () => {
  assert.equal(formatarNumero(1234.56, 2), '1.234,56');
  assert.equal(formatarNumero(17000), '17.000');
  assert.equal(formatarMoeda(19.5), '19,50');
});

test('datas aceitam os formatos do escritório', () => {
  assert.equal(formatarData(converterData('27/11/2026')!), '27/11/2026');
  assert.equal(formatarData(converterData('27/11/26')!), '27/11/2026');
  assert.equal(formatarData(converterData('27-11-2026')!), '27/11/2026');
  assert.equal(formatarData(converterData('27.11.2026')!), '27/11/2026');
  assert.equal(formatarData(converterData('27112026')!), '27/11/2026');
  assert.equal(formatarData(converterData('271126')!), '27/11/2026');
  assert.equal(converterData('31/02/2026'), null);
  assert.equal(converterData('27/13/2026'), null);
});

test('datas ISO', () => {
  assert.equal(dataIso(new Date(2026, 10, 27)), '2026-11-27');
  assert.equal(formatarData(isoParaData('2026-11-27')!), '27/11/2026');
  assert.equal(isoParaData('2026-11-27T12:00:00'), null);
});

test('busca de opções: código, nome, token numérico e trecho', () => {
  const opcoes = [
    { valor: '4229791', rotulo: 'Operação 3: JL MEDEIROS LEVAMAIS MACAU (4229791)' },
    { valor: '100', rotulo: 'Cliente Água Boa' },
    { valor: '200', rotulo: 'Cliente São José' },
    { valor: '999', rotulo: 'Cliente União (1000)' },
  ];
  assert.equal(normalizarBusca('ÁGUA'), 'agua');
  assert.equal(localizarOpcao(opcoes, '100')?.valor, '100');
  assert.equal(localizarOpcao(opcoes, 'cliente agua')?.valor, '100');
  assert.equal(localizarOpcao(opcoes, 'sao jose')?.valor, '200');
  assert.equal(localizarOpcao(opcoes, '4229791')?.valor, '4229791');
  assert.equal(localizarOpcao(opcoes, 'macau')?.valor, '4229791');
  assert.equal(localizarOpcao(opcoes, '42')?.valor, '4229791'); // começa com o código
  assert.equal(localizarOpcao(opcoes, '1000')?.valor, '999'); // token numérico dentro do rótulo
  assert.equal(localizarOpcao(opcoes, 'inexistente'), null);
});
