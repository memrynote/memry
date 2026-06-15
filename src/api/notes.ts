import axios from 'axios';

const getNotes = async () => {
  const response = await axios.get('/notes');
  return response.data;
};

const createNote = async (note: any) => {
  const response = await axios.post('/notes', note);
  return response.data;
};

export { getNotes, createNote };