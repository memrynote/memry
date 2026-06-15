import React from 'react';
import NoteBlock from '../components/NoteBlock';

interface CalendarProps {
  notes: any[];
}

const Calendar: React.FC<CalendarProps> = ({ notes }) => {
  return (
    <div>
      {notes.map((note) => (
        <NoteBlock key={note.id} type={note.type} note={note} />
      ))}
    </div>
  );
};

export default Calendar;