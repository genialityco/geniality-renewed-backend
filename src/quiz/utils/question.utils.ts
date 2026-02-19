/**
 * Utilidades para validar y procesar preguntas de quiz
 */

import {
  Question,
  SingleChoiceQuestion,
  MultipleChoiceQuestion,
  MatchingQuestion,
  OrderingQuestion,
} from '../types/quiz.types';

/**
 * Valida que el índice de respuesta correcta exista en las opciones
 */
export function validateSingleChoiceAnswer(
  question: SingleChoiceQuestion,
): boolean {
  if (question.respuestacorrecta < 0 || question.respuestacorrecta >= question.opciones.length) {
    return false;
  }
  return true;
}

/**
 * Valida que los índices de respuestas correctas existan en las opciones
 */
export function validateMultipleChoiceAnswers(
  question: MultipleChoiceQuestion,
): boolean {
  return question.respuestascorrectas.every(
    (idx) => idx >= 0 && idx < question.opciones.length,
  );
}

/**
 * Valida que el orden correcto contenga IDs válidos de items
 */
export function validateOrderingAnswers(
  question: OrderingQuestion,
): boolean {
  const itemIds = new Set(question.items.map((item) => item.id));
  return question.correctOrder.every((id) => itemIds.has(id));
}

/**
 * Valida la integridad completa de una pregunta
 */
export function validateQuestion(question: Question): boolean {
  if (!question.id || !question.blocks || question.blocks.length === 0) {
    return false;
  }

  switch (question.type) {
    case 'single-choice':
      return (
        question.opciones && question.opciones.length > 0 && validateSingleChoiceAnswer(question)
      );
    case 'multiple-choice':
      return (
        question.opciones &&
        question.opciones.length > 0 &&
        validateMultipleChoiceAnswers(question)
      );
    case 'matching':
      return question.pairs && question.pairs.length > 0;
    case 'ordering':
      return question.items && question.items.length > 0 && validateOrderingAnswers(question);
    default:
      return false;
  }
}

/**
 * Extrae el texto de los bloques para búsqueda o display
 */
export function extractTextFromBlocks(blocks: any[]): string {
  return blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.content)
    .join(' ');
}

/**
 * Valida una respuesta de usuario para una pregunta
 */
export function validateUserAnswer(
  question: Question,
  userAnswer: any,
): boolean {
  switch (question.type) {
    case 'single-choice':
      return (
        typeof userAnswer === 'number' &&
        userAnswer >= 0 &&
        userAnswer < question.opciones.length
      );
    case 'multiple-choice':
      return (
        Array.isArray(userAnswer) &&
        userAnswer.every((idx) => typeof idx === 'number' && idx >= 0 && idx < question.opciones.length)
      );
    case 'matching':
      return (
        typeof userAnswer === 'object' &&
        Object.keys(userAnswer).every((leftId) => {
          const pair = question.pairs.find((p) => p.id === leftId);
          return pair && Object.values(question.pairs).find((p: any) => p.id === userAnswer[leftId]);
        })
      );
    case 'ordering':
      return (
        Array.isArray(userAnswer) &&
        userAnswer.length === question.items.length &&
        userAnswer.every((id) => question.items.some((item) => item.id === id))
      );
    default:
      return false;
  }
}

/**
 * Calcula si la respuesta es correcta
 */
export function isAnswerCorrect(
  question: Question,
  userAnswer: any,
): boolean {
  if (!validateUserAnswer(question, userAnswer)) {
    return false;
  }

  switch (question.type) {
    case 'single-choice':
      return userAnswer === (question as SingleChoiceQuestion).respuestacorrecta;
    case 'multiple-choice':
      const correctAnswers = (question as MultipleChoiceQuestion)
        .respuestascorrectas;
      return (
        Array.isArray(userAnswer) &&
        userAnswer.length === correctAnswers.length &&
        userAnswer.every((idx) => correctAnswers.includes(idx))
      );
    case 'matching':
      // Implementar lógica de emparejamiento si es necesario
      return true;
    case 'ordering':
      const correctOrder = (question as OrderingQuestion).correctOrder;
      return (
        Array.isArray(userAnswer) &&
        userAnswer.every((id, idx) => id === correctOrder[idx])
      );
    default:
      return false;
  }
}
